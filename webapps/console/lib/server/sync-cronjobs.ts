import { getServerEnv } from "./serverEnv";

const OVERRIDE_ON = "cronjobs=true";
const OVERRIDE_OFF = "cronjobs=false";

/**
 * Whether the autonomous K8s CronJob path is enabled for a workspace.
 *
 * Resolution order (first match wins):
 *   1. workspace `featuresEnabled` contains `cronjobs=false` → disabled
 *   2. workspace `featuresEnabled` contains `cronjobs=true`  → enabled
 *   3. fall back to global env `SYNCS_CRONJOB_ENABLED`
 *
 * When enabled, syncs in that workspace are:
 *   - emitted by the admin /export/syncs endpoint (so syncctl reconciles a
 *     K8s CronJob for each one), and
 *   - NOT scheduled via the legacy Cloud Scheduler → /sources/run path
 *     (scheduled triggers for those workspaces are ignored to prevent
 *     double-execution).
 *
 * Manual user-triggered runs of /sources/run keep working regardless.
 */
export function cronjobsEnabledForWorkspace(featuresEnabled: string[] | null | undefined): boolean {
  const features = featuresEnabled ?? [];
  if (features.includes(OVERRIDE_OFF)) {
    return false;
  }
  if (features.includes(OVERRIDE_ON)) {
    return true;
  }
  return getServerEnv().SYNCS_CRONJOB_ENABLED;
}
