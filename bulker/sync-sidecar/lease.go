package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jitsucom/bulker/jitsubase/logging"
)

// Lease subcommand + helpers. Implemented against the Kubernetes coordination/v1
// Lease API directly via HTTP (using the in-cluster service account credentials)
// to avoid pulling client-go into sync-sidecar's dependency closure.
//
// Per-sync mutual exclusion model:
//   - Lease name: SYNC_ID
//   - Holder identity: SYNC_ID (the lease *represents* the sync run, not a pod)
//   - leaseDurationSeconds: 60
//   - Init container `lease-acquire` calls Acquire() with a short retry budget
//     and exits non-zero if the lease is currently held (= another pod for this
//     same sync is already running)
//   - Main sidecar runs RenewLeaseLoop() in a goroutine, refreshing every 20s.
//     If a refresh detects we no longer hold the lease (renewTime advanced past
//     ours, or the lease object disappeared and was recreated by someone else),
//     the sidecar SIGTERMs PID 1 to terminate the entire Pod.

const (
	leaseAPIPath           = "/apis/coordination.k8s.io/v1/namespaces/%s/leases"
	leaseSAPath            = "/var/run/secrets/kubernetes.io/serviceaccount"
	leaseDurationSeconds   = 60
	leaseAcquireMaxAttempts = 10
	leaseAcquireBackoff    = 500 * time.Millisecond
	leaseRenewInterval     = 20 * time.Second
)

type Lease struct {
	APIVersion string        `json:"apiVersion"`
	Kind       string        `json:"kind"`
	Metadata   LeaseMetadata `json:"metadata"`
	Spec       LeaseSpec     `json:"spec"`
}

type LeaseMetadata struct {
	Name            string `json:"name"`
	Namespace       string `json:"namespace,omitempty"`
	ResourceVersion string `json:"resourceVersion,omitempty"`
}

type LeaseSpec struct {
	HolderIdentity       string `json:"holderIdentity,omitempty"`
	LeaseDurationSeconds int32  `json:"leaseDurationSeconds,omitempty"`
	AcquireTime          string `json:"acquireTime,omitempty"`
	RenewTime            string `json:"renewTime,omitempty"`
}

type leaseClient struct {
	http      *http.Client
	apiServer string
	token     string
	namespace string
}

func newLeaseClient(namespace string) (*leaseClient, error) {
	tokenBytes, err := os.ReadFile(leaseSAPath + "/token")
	if err != nil {
		return nil, fmt.Errorf("read SA token: %w", err)
	}
	caBytes, err := os.ReadFile(leaseSAPath + "/ca.crt")
	if err != nil {
		return nil, fmt.Errorf("read SA ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("appending SA ca to cert pool")
	}
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" {
		host = "kubernetes.default.svc"
	}
	if port == "" {
		port = "443"
	}
	return &leaseClient{
		http: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool},
			},
		},
		apiServer: fmt.Sprintf("https://%s:%s", host, port),
		token:     string(bytes.TrimSpace(tokenBytes)),
		namespace: namespace,
	}, nil
}

func (c *leaseClient) url(name string) string {
	if name == "" {
		return c.apiServer + fmt.Sprintf(leaseAPIPath, c.namespace)
	}
	return c.apiServer + fmt.Sprintf(leaseAPIPath, c.namespace) + "/" + name
}

func (c *leaseClient) do(method, name string, body any) (*Lease, int, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.url(name), reqBody)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, resp.StatusCode, nil
	}
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, fmt.Errorf("k8s API %d: %s", resp.StatusCode, string(respBody))
	}
	if len(respBody) == 0 {
		return nil, resp.StatusCode, nil
	}
	out := &Lease{}
	if err := json.Unmarshal(respBody, out); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("decode lease response: %w", err)
	}
	return out, resp.StatusCode, nil
}

func (c *leaseClient) Get(name string) (*Lease, error) {
	l, status, err := c.do("GET", name, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, nil
	}
	return l, nil
}

// Acquire returns true if we successfully claim the lease for `identity`.
// Returns false (no error) when the lease is currently held by a fresh holder.
func (c *leaseClient) Acquire(name, identity string) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	existing, err := c.Get(name)
	if err != nil {
		return false, err
	}

	if existing == nil {
		// Create a fresh lease.
		newLease := &Lease{
			APIVersion: "coordination.k8s.io/v1",
			Kind:       "Lease",
			Metadata:   LeaseMetadata{Name: name, Namespace: c.namespace},
			Spec: LeaseSpec{
				HolderIdentity:       identity,
				LeaseDurationSeconds: leaseDurationSeconds,
				AcquireTime:          now,
				RenewTime:            now,
			},
		}
		_, status, err := c.do("POST", "", newLease)
		if err != nil {
			if status == http.StatusConflict {
				// Lost a race with another pod creating it; reload and treat as held.
				return false, nil
			}
			return false, err
		}
		return true, nil
	}

	// Lease exists — is it stale?
	if !leaseIsStale(existing) {
		return false, nil
	}

	// Take it over.
	existing.Spec.HolderIdentity = identity
	existing.Spec.LeaseDurationSeconds = leaseDurationSeconds
	existing.Spec.AcquireTime = now
	existing.Spec.RenewTime = now
	_, status, err := c.do("PUT", name, existing)
	if err != nil {
		if status == http.StatusConflict {
			// Another pod won the race.
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Renew extends our hold on the lease. Returns false if the lease was taken
// by someone else (renewTime advanced past ours, or it disappeared).
func (c *leaseClient) Renew(name, identity string) (bool, error) {
	existing, err := c.Get(name)
	if err != nil {
		return false, err
	}
	if existing == nil || existing.Spec.HolderIdentity != identity {
		return false, nil
	}
	existing.Spec.RenewTime = time.Now().UTC().Format(time.RFC3339)
	_, status, err := c.do("PUT", name, existing)
	if err != nil {
		if status == http.StatusConflict || status == http.StatusNotFound {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Release best-effort deletes the lease so the next acquire is unblocked.
// Failures are logged but not returned — the lease will expire naturally
// after leaseDurationSeconds anyway.
func (c *leaseClient) Release(name string) {
	_, _, err := c.do("DELETE", name, nil)
	if err != nil {
		logging.Warnf("[lease] release %q failed (will expire on its own): %v", name, err)
	}
}

func leaseIsStale(l *Lease) bool {
	if l.Spec.RenewTime == "" {
		return true
	}
	renewedAt, err := time.Parse(time.RFC3339, l.Spec.RenewTime)
	if err != nil {
		// If we can't parse, treat as stale so we can take over.
		return true
	}
	dur := time.Duration(l.Spec.LeaseDurationSeconds) * time.Second
	if dur == 0 {
		dur = leaseDurationSeconds * time.Second
	}
	return time.Now().After(renewedAt.Add(dur))
}

// runLeaseAcquire is the lease-acquire init container entry point. Reads
// SYNC_ID + KUBE_NAMESPACE from env, retries acquire briefly, exits 0 on
// success or 1 on failure (fresh lease held by another pod).
func runLeaseAcquire() {
	syncID := os.Getenv("SYNC_ID")
	namespace := os.Getenv("KUBE_NAMESPACE")
	if syncID == "" || namespace == "" {
		logging.Errorf("[lease-acquire] SYNC_ID and KUBE_NAMESPACE are required")
		os.Exit(2)
	}
	c, err := newLeaseClient(namespace)
	if err != nil {
		logging.Errorf("[lease-acquire] init: %v", err)
		os.Exit(2)
	}
	for attempt := 1; attempt <= leaseAcquireMaxAttempts; attempt++ {
		acquired, err := c.Acquire(syncID, syncID)
		if err != nil {
			logging.Warnf("[lease-acquire] attempt %d: %v", attempt, err)
		} else if acquired {
			logging.Infof("[lease-acquire] acquired lease %q", syncID)
			os.Exit(0)
		} else {
			logging.Infof("[lease-acquire] attempt %d: lease %q held by another holder", attempt, syncID)
		}
		time.Sleep(leaseAcquireBackoff)
	}
	logging.Errorf("[lease-acquire] giving up after %d attempts; lease %q is held", leaseAcquireMaxAttempts, syncID)
	os.Exit(1)
}

// startLeaseRenewer launches a background goroutine that keeps the lease
// alive while the main sidecar processes records. If the lease can't be
// renewed (lost it), the goroutine SIGTERMs PID 1 to terminate the Pod and
// stops the sync run mid-flight.
//
// Triggered when env RENEW_LEASE=true is set on the sidecar container.
// Stop the renewal by Release()-ing or just letting the function return on
// program exit (the goroutine ends with the process).
func startLeaseRenewer() {
	if os.Getenv("RENEW_LEASE") != "true" {
		return
	}
	syncID := os.Getenv("SYNC_ID")
	namespace := os.Getenv("KUBE_NAMESPACE")
	if syncID == "" || namespace == "" {
		logging.Warnf("[lease-renew] disabled: SYNC_ID and KUBE_NAMESPACE both required")
		return
	}
	client, err := newLeaseClient(namespace)
	if err != nil {
		logging.Errorf("[lease-renew] init: %v (sidecar will continue WITHOUT lease renewal)", err)
		return
	}
	var lostLease atomic.Bool
	go func() {
		t := time.NewTicker(leaseRenewInterval)
		defer t.Stop()
		for {
			<-t.C
			if lostLease.Load() {
				return
			}
			ok, err := client.Renew(syncID, syncID)
			if err != nil {
				logging.Warnf("[lease-renew] %v (will retry)", err)
				continue
			}
			if !ok {
				lostLease.Store(true)
				logging.Errorf("[lease-renew] lease %q lost — terminating Pod", syncID)
				// shareProcessNamespace=true means the source connector's
				// process is reachable. SIGTERM PID 1 (the pause container);
				// kubelet will clean up siblings.
				if err := syscall.Kill(1, syscall.SIGTERM); err != nil {
					logging.Errorf("[lease-renew] SIGTERM PID 1 failed: %v", err)
					// Last resort: just exit; the source connector will see
					// EOF on its pipes shortly.
					os.Exit(int(syscall.SIGTERM))
				}
				return
			}
		}
	}()
}

// Helper used by syncctl's /run admission gate (via HTTP, not in this binary).
// Kept here so the lease key naming convention has one definition.
func LeaseNameForSync(syncID string) string {
	return syncID
}

// Used by load-catalog-state to compute deadlines.
var _ = strconv.Itoa // appease linter if no other strconv usage
