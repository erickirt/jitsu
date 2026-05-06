package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/hjson/hjson-go/v4"
	"github.com/jitsucom/bulker/jitsubase/appbase"
	"github.com/jitsucom/bulker/jitsubase/logging"
	"github.com/jitsucom/bulker/jitsubase/safego"
	"github.com/jitsucom/bulker/jitsubase/utils"
	batchv1 "k8s.io/api/batch/v1"
	v1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"
)

// Labels syncctl uses to identify resources it owns. The reconciler treats
// any CronJob carrying labelManagedBy=managedByValue as authoritative — it
// will create / update / delete to converge them with the polled SyncsData.
const (
	labelSyncID      = "jitsu.com/sync-id"
	labelWorkspaceID = "jitsu.com/workspace-id"
	labelManagedBy   = "jitsu.com/managed-by"
	labelAppName     = "app"
	managedByValue   = "syncctl"
	cronJobAppValue  = "sync-cron"
	cronJobNameFmt   = "sync-%s"      // CronJob.metadata.name
	cronSecretFmt    = "sync-%s-cfg"  // per-CronJob Secret holding source/destination configs
)

// CronJobController watches a SyncsRepository and reconciles k8s CronJobs +
// per-CronJob Secrets in syncctl's namespace.
type CronJobController struct {
	appbase.Service
	config    *Config
	clientset *kubernetes.Clientset
	repo      appbase.Repository[SyncsData]
	jobRunner *JobRunner
	closed    chan struct{}
}

func NewCronJobController(ctx *Context) *CronJobController {
	return &CronJobController{
		Service:   appbase.NewServiceBase("cronjob-controller"),
		config:    ctx.config,
		clientset: ctx.jobRunner.clientset,
		repo:      ctx.syncsRepo,
		jobRunner: ctx.jobRunner,
		closed:    make(chan struct{}),
	}
}

// Start spins up the reconcile loop. Blocks until the repo is initially
// loaded, then reconciles on every change notification.
func (c *CronJobController) Start() {
	safego.Run(func() {
		c.Infof("CronJob controller started")
		// Wait for first repository load before reconciling — avoids
		// deleting all CronJobs because we briefly saw an empty SyncsData.
		for !c.repo.Loaded() {
			select {
			case <-time.After(2 * time.Second):
			case <-c.closed:
				return
			}
		}
		c.reconcile()
		for {
			select {
			case <-c.repo.ChangesChannel():
				c.reconcile()
			case <-c.closed:
				c.Infof("CronJob controller closing")
				return
			}
		}
	})
}

func (c *CronJobController) Close() error {
	close(c.closed)
	return nil
}

func (c *CronJobController) reconcile() {
	data := c.repo.GetData()
	if data == nil {
		c.Warnf("reconcile: SyncsData is nil, skipping")
		return
	}

	// Build the desired set: any sync with a non-empty schedule needs a CronJob.
	desired := make(map[string]*SyncEntry, len(data.Syncs))
	for _, s := range data.Syncs {
		if strings.TrimSpace(s.Schedule) == "" {
			continue
		}
		desired[s.ID] = s
	}

	// List currently-managed CronJobs.
	current, err := c.clientset.BatchV1().CronJobs(c.config.KubernetesNamespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: fmt.Sprintf("%s=%s", labelManagedBy, managedByValue),
	})
	if err != nil {
		c.Errorf("failed to list CronJobs: %v", err)
		return
	}

	currentByID := make(map[string]*batchv1.CronJob, len(current.Items))
	for i := range current.Items {
		cj := &current.Items[i]
		syncID := cj.Labels[labelSyncID]
		if syncID == "" {
			continue
		}
		currentByID[syncID] = cj
	}

	created, updated, deleted := 0, 0, 0
	for id, entry := range desired {
		existing := currentByID[id]
		if existing == nil {
			if err := c.createCronJob(entry); err != nil {
				c.Errorf("create CronJob %s: %v", id, err)
				continue
			}
			created++
		} else {
			changed, err := c.updateCronJobIfDrifted(existing, entry)
			if err != nil {
				c.Errorf("update CronJob %s: %v", id, err)
				continue
			}
			if changed {
				updated++
			}
		}
	}
	for id := range currentByID {
		if _, ok := desired[id]; ok {
			continue
		}
		if err := c.deleteCronJob(id); err != nil {
			c.Errorf("delete CronJob %s: %v", id, err)
			continue
		}
		deleted++
	}

	c.Infof("reconcile: desired=%d current=%d created=%d updated=%d deleted=%d",
		len(desired), len(currentByID), created, updated, deleted)
}

// configHash is recorded in an annotation on each CronJob so we can detect
// drift without diffing the whole spec. A change in the polled SyncEntry
// produces a different hash → reconciler patches the CronJob + Secret.
func configHash(entry *SyncEntry) string {
	b, _ := json.Marshal(struct {
		Schedule    string          `json:"s"`
		Timezone    string          `json:"tz"`
		SrcPkg      string          `json:"sp"`
		SrcVer      string          `json:"sv"`
		SrcCfg      json.RawMessage `json:"sc"`
		DestType    string          `json:"dt"`
		DestCfg     json.RawMessage `json:"dc"`
		Options     json.RawMessage `json:"o"`
	}{
		Schedule: entry.Schedule,
		Timezone: entry.Timezone,
		SrcPkg:   entry.Source.Package,
		SrcVer:   entry.Source.Version,
		SrcCfg:   entry.Source.Config,
		DestType: entry.Destination.Type,
		DestCfg:  entry.Destination.Config,
		Options:  entry.Options,
	})
	return utils.HashStringS(string(b))
}

const annotationConfigHash = "jitsu.com/config-hash"

func (c *CronJobController) createCronJob(entry *SyncEntry) error {
	if err := c.upsertSecret(entry); err != nil {
		return fmt.Errorf("upsert secret: %w", err)
	}
	cj := c.buildCronJob(entry)
	_, err := c.clientset.BatchV1().CronJobs(c.config.KubernetesNamespace).Create(context.Background(), cj, metav1.CreateOptions{})
	if err != nil {
		if errors.IsAlreadyExists(err) {
			// Race with another syncctl instance; treat as success.
			return nil
		}
		return err
	}
	c.Infof("created CronJob sync-%s (schedule=%q)", entry.ID, entry.Schedule)
	return nil
}

func (c *CronJobController) updateCronJobIfDrifted(existing *batchv1.CronJob, entry *SyncEntry) (bool, error) {
	desiredHash := configHash(entry)
	if existing.Annotations[annotationConfigHash] == desiredHash {
		return false, nil
	}
	if err := c.upsertSecret(entry); err != nil {
		return false, fmt.Errorf("upsert secret: %w", err)
	}
	desired := c.buildCronJob(entry)
	desired.ResourceVersion = existing.ResourceVersion
	_, err := c.clientset.BatchV1().CronJobs(c.config.KubernetesNamespace).Update(context.Background(), desired, metav1.UpdateOptions{})
	if err != nil {
		return false, err
	}
	c.Infof("updated CronJob sync-%s (schedule=%q)", entry.ID, entry.Schedule)
	return true, nil
}

func (c *CronJobController) deleteCronJob(syncID string) error {
	name := fmt.Sprintf(cronJobNameFmt, syncID)
	policy := metav1.DeletePropagationBackground
	err := c.clientset.BatchV1().CronJobs(c.config.KubernetesNamespace).Delete(context.Background(), name, metav1.DeleteOptions{PropagationPolicy: &policy})
	if err != nil && !errors.IsNotFound(err) {
		return err
	}
	// Best-effort delete of the per-CronJob Secret. Ignore NotFound.
	secretName := fmt.Sprintf(cronSecretFmt, syncID)
	_ = c.clientset.CoreV1().Secrets(c.config.KubernetesNamespace).Delete(context.Background(), secretName, metav1.DeleteOptions{})
	c.Infof("deleted CronJob sync-%s", syncID)
	return nil
}

// upsertSecret creates or updates the per-CronJob Secret holding the source
// config.json + destination.json that the Pod's containers consume.
func (c *CronJobController) upsertSecret(entry *SyncEntry) error {
	name := fmt.Sprintf(cronSecretFmt, entry.ID)
	data := map[string][]byte{
		"config.json":      entry.Source.Config,
		"destination.json": entry.Destination.Config,
	}
	secret := &v1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: c.config.KubernetesNamespace,
			Labels: map[string]string{
				labelManagedBy:   managedByValue,
				labelSyncID:      entry.ID,
				labelWorkspaceID: entry.WorkspaceID,
			},
		},
		Type: v1.SecretTypeOpaque,
		Data: data,
	}
	_, err := c.clientset.CoreV1().Secrets(c.config.KubernetesNamespace).Create(context.Background(), secret, metav1.CreateOptions{})
	if err == nil {
		return nil
	}
	if !errors.IsAlreadyExists(err) {
		return err
	}
	_, err = c.clientset.CoreV1().Secrets(c.config.KubernetesNamespace).Update(context.Background(), secret, metav1.UpdateOptions{})
	return err
}

// buildCronJob assembles the full CronJob object for a sync entry. Wraps
// buildCronPodTemplate so reconcile + tests can construct one declaratively.
func (c *CronJobController) buildCronJob(entry *SyncEntry) *batchv1.CronJob {
	startingDeadlineSeconds := int64(60) // skip a missed schedule rather than back-stack it
	successHistory := int32(1)
	failureHistory := int32(3)

	jobSpec := batchv1.JobSpec{
		BackoffLimit:          ptr.To(c.config.JobBackoffLimit),
		ActiveDeadlineSeconds: ptr.To(int64(c.config.JobActiveDeadlineSeconds)),
		Template:              c.buildCronPodTemplate(entry),
	}

	return &batchv1.CronJob{
		TypeMeta: metav1.TypeMeta{Kind: "CronJob", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf(cronJobNameFmt, entry.ID),
			Namespace: c.config.KubernetesNamespace,
			Labels: map[string]string{
				labelManagedBy:   managedByValue,
				labelAppName:     cronJobAppValue,
				labelSyncID:      entry.ID,
				labelWorkspaceID: entry.WorkspaceID,
			},
			Annotations: map[string]string{
				annotationConfigHash: configHash(entry),
			},
		},
		Spec: batchv1.CronJobSpec{
			Schedule:                   entry.Schedule,
			TimeZone:                   ptr.To(entry.Timezone),
			ConcurrencyPolicy:          batchv1.ForbidConcurrent,
			StartingDeadlineSeconds:    &startingDeadlineSeconds,
			SuccessfulJobsHistoryLimit: &successHistory,
			FailedJobsHistoryLimit:     &failureHistory,
			JobTemplate: batchv1.JobTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						labelManagedBy:   managedByValue,
						labelAppName:     cronJobAppValue,
						labelSyncID:      entry.ID,
						labelWorkspaceID: entry.WorkspaceID,
					},
				},
				Spec: jobSpec,
			},
		},
	}
}

// buildCronPodTemplate builds the autonomous Pod template embedded in each
// CronJob's jobTemplate. Init container chain:
//
//	lease-acquire           — exits non-zero if Lease "<syncId>" is held
//	discover (conditional)  — airbyte source `discover`, output to /shared/discover.jsonl
//	load-catalog-state      — parses /shared/discover.jsonl (if present) into source_catalog,
//	                          then reads source_catalog + source_state from DB,
//	                          applies selectStreamsFromCatalog using OPTIONS_JSON,
//	                          writes /shared/catalog.json + /shared/state.json
//	pipes-init              — creates fifos for source ↔ sidecar streaming
//
// Main containers: source (airbyte read) + sidecar (existing default mode +
// lease-renewal goroutine; SIGTERMs source via shareProcessNamespace if it
// loses the lease).
func (c *CronJobController) buildCronPodTemplate(entry *SyncEntry) v1.PodTemplateSpec {
	var opts struct {
		SchemaChanges string `json:"schemaChanges"`
		VersionHash   string `json:"versionHash"`
	}
	_ = json.Unmarshal(entry.Options, &opts)
	needsDiscover := opts.SchemaChanges == "fields" || opts.SchemaChanges == "streams"

	sourceImage := fmt.Sprintf("%s:%s", entry.Source.Package, entry.Source.Version)
	configSecretName := fmt.Sprintf(cronSecretFmt, entry.ID)
	databaseURL := utils.NvlString(c.config.SidecarDatabaseURL, c.config.DatabaseURL)

	configMount := v1.VolumeMount{Name: "config", MountPath: "/config"}
	sharedMount := v1.VolumeMount{Name: "shared", MountPath: "/shared"}
	pipesMount := v1.VolumeMount{Name: "pipes", MountPath: "/pipes"}

	// Env shared by every sync-sidecar invocation in the Pod (init + main).
	baseEnv := []v1.EnvVar{
		{Name: "SYNC_ID", Value: entry.ID},
		{Name: "WORKSPACE_ID", Value: entry.WorkspaceID},
		{Name: "PACKAGE", Value: entry.Source.Package},
		{Name: "PACKAGE_VERSION", Value: entry.Source.Version},
		{Name: "STORAGE_KEY", Value: opts.VersionHash},
		{Name: "DATABASE_URL", Value: databaseURL},
		{Name: "KUBE_NAMESPACE", Value: c.config.KubernetesNamespace},
		{Name: "POD_NAME", ValueFrom: &v1.EnvVarSource{FieldRef: &v1.ObjectFieldSelector{FieldPath: "metadata.name"}}},
		{Name: "LOG_LEVEL", Value: c.config.LogLevel},
		{Name: "DB_LOG_LEVEL", Value: c.config.DBLogLevel},
	}

	initContainers := []v1.Container{
		{
			Name:    "lease-acquire",
			Image:   c.config.SidecarImage,
			Command: []string{"/sync-sidecar", "lease-acquire"},
			Env:     baseEnv,
			Resources: smallResources(),
		},
	}

	if needsDiscover {
		// Run airbyte source `discover`; capture mixed JSONL output to
		// /shared/discover.jsonl for the load-catalog-state init to parse.
		initContainers = append(initContainers, v1.Container{
			Name:  "discover",
			Image: sourceImage,
			Command: []string{"sh", "-c",
				`eval "$AIRBYTE_ENTRYPOINT discover --config /config/config.json" > /shared/discover.jsonl 2> /shared/discover.stderr`},
			Env: []v1.EnvVar{
				{Name: "USE_STREAM_CAPABLE_STATE", Value: "true"},
				{Name: "AUTO_DETECT_SCHEMA", Value: "true"},
			},
			VolumeMounts: []v1.VolumeMount{configMount, sharedMount},
			Resources:    sourceResources(),
		})
	}

	loadEnv := append([]v1.EnvVar{}, baseEnv...)
	loadEnv = append(loadEnv,
		v1.EnvVar{Name: "OPTIONS_JSON", Value: string(entry.Options)},
	)
	initContainers = append(initContainers, v1.Container{
		Name:         "load-catalog-state",
		Image:        c.config.SidecarImage,
		Command:      []string{"/sync-sidecar", "load-catalog-state"},
		Env:          loadEnv,
		VolumeMounts: []v1.VolumeMount{configMount, sharedMount},
		Resources:    smallResources(),
	})

	initContainers = append(initContainers, v1.Container{
		Name:         "pipes-init",
		Image:        "alpine",
		Command:      []string{"sh", "-c", "mkfifo /pipes/stdout; mkfifo /pipes/stderr; chmod 777 /pipes/*"},
		VolumeMounts: []v1.VolumeMount{pipesMount},
		Resources:    smallResources(),
	})

	sidecarEnv := append([]v1.EnvVar{}, baseEnv...)
	sidecarEnv = append(sidecarEnv,
		v1.EnvVar{Name: "STDOUT_PIPE_FILE", Value: "/pipes/stdout"},
		v1.EnvVar{Name: "STDERR_PIPE_FILE", Value: "/pipes/stderr"},
		v1.EnvVar{Name: "COMMAND", Value: "read"},
		v1.EnvVar{Name: "DESTINATION_TYPE", Value: entry.Destination.Type},
		v1.EnvVar{Name: "TASK_TIMEOUT_HOURS", Value: strconv.Itoa(c.config.TaskTimeoutHours)},
		v1.EnvVar{Name: "LOCAL_INGEST_ENDPOINT", Value: c.config.LocalIngestEndpoint},
		v1.EnvVar{Name: "GLOBAL_INGEST_ENDPOINT", Value: c.config.GlobalIngestEndpoint},
		v1.EnvVar{Name: "RENEW_LEASE", Value: "true"},
	)

	pod := v1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{
			Labels: map[string]string{
				labelManagedBy:   managedByValue,
				labelAppName:     cronJobAppValue,
				labelSyncID:      entry.ID,
				labelWorkspaceID: entry.WorkspaceID,
			},
		},
		Spec: v1.PodSpec{
			RestartPolicy:                 v1.RestartPolicyNever,
			ShareProcessNamespace:         ptr.To(true),
			TerminationGracePeriodSeconds: ptr.To(int64(c.config.ContainerGraceShutdownSeconds)),
			ServiceAccountName:            c.config.PodsServiceAccount,
			NodeSelector:                  parseNodeSelector(c.config.KubernetesNodeSelector),
			InitContainers:                initContainers,
			Containers: []v1.Container{
				{
					Name:    "source",
					Image:   sourceImage,
					Command: []string{"sh", "-c", `eval "$AIRBYTE_ENTRYPOINT read --config /config/config.json --catalog /shared/catalog.json --state /shared/state.json" 2> /pipes/stderr > /pipes/stdout`},
					Env: []v1.EnvVar{
						{Name: "USE_STREAM_CAPABLE_STATE", Value: "true"},
						{Name: "AUTO_DETECT_SCHEMA", Value: "true"},
						{Name: "JAVA_OPTS", Value: "-Xmx7000m"},
					},
					VolumeMounts: []v1.VolumeMount{configMount, sharedMount, pipesMount},
					Resources:    sourceResources(),
				},
				{
					Name:            "sidecar",
					Image:           c.config.SidecarImage,
					ImagePullPolicy: v1.PullAlways,
					Env:             sidecarEnv,
					VolumeMounts:    []v1.VolumeMount{configMount, sharedMount, pipesMount},
					Resources:       sidecarResources(),
				},
			},
			Volumes: []v1.Volume{
				{Name: "config", VolumeSource: v1.VolumeSource{Secret: &v1.SecretVolumeSource{SecretName: configSecretName}}},
				{Name: "shared", VolumeSource: v1.VolumeSource{EmptyDir: &v1.EmptyDirVolumeSource{}}},
				{Name: "pipes", VolumeSource: v1.VolumeSource{EmptyDir: &v1.EmptyDirVolumeSource{}}},
			},
		},
	}
	return pod
}

func parseNodeSelector(raw string) map[string]string {
	if raw == "" {
		return nil
	}
	out := map[string]string{}
	if err := hjson.Unmarshal([]byte(raw), &out); err != nil {
		logging.Errorf("[cronjob-controller] invalid KUBERNETES_NODE_SELECTOR=%q, ignoring: %v", raw, err)
		return nil
	}
	return out
}

func sourceResources() v1.ResourceRequirements {
	return v1.ResourceRequirements{
		Limits: v1.ResourceList{
			v1.ResourceCPU:    *resource.NewMilliQuantity(int64(1000), resource.DecimalSI),
			v1.ResourceMemory: *resource.NewQuantity(int64(math.Pow(2, 33)), resource.BinarySI), // 8Gi
		},
		Requests: v1.ResourceList{
			v1.ResourceCPU:    *resource.NewMilliQuantity(int64(100), resource.DecimalSI),
			v1.ResourceMemory: *resource.NewQuantity(int64(math.Pow(2, 28)), resource.BinarySI), // 256Mi
		},
	}
}

func sidecarResources() v1.ResourceRequirements {
	return v1.ResourceRequirements{
		Limits: v1.ResourceList{
			v1.ResourceCPU:    *resource.NewMilliQuantity(int64(500), resource.DecimalSI),
			v1.ResourceMemory: *resource.NewQuantity(int64(math.Pow(2, 32)), resource.BinarySI), // 4Gi
		},
	}
}

func smallResources() v1.ResourceRequirements {
	return v1.ResourceRequirements{
		Limits: v1.ResourceList{
			v1.ResourceCPU:    *resource.NewMilliQuantity(int64(200), resource.DecimalSI),
			v1.ResourceMemory: *resource.NewQuantity(int64(math.Pow(2, 28)), resource.BinarySI), // 256Mi
		},
	}
}
