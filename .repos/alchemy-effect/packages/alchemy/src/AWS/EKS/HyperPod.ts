/**
 * First-class SageMaker HyperPod scheduling for EKS workloads.
 *
 * HyperPod nodes are ordinary EKS nodes carrying well-known labels, and
 * HyperPod task governance rides on Kueue conventions. `AWS.EKS.Job` and
 * `AWS.EKS.Deployment` accept these props under `hyperpod:` and derive the
 * node selector, namespace, and Kueue labels — no manual label wiring.
 */

/** The well-known node label carrying the HyperPod instance-group name. */
export const HYPERPOD_INSTANCE_GROUP_LABEL =
  "sagemaker.amazonaws.com/instance-group-name";

/** The well-known node label carrying HyperPod's node health verdict. */
export const HYPERPOD_NODE_HEALTH_LABEL =
  "sagemaker.amazonaws.com/node-health-status";

/** Kueue label selecting the task-governance queue. */
export const KUEUE_QUEUE_NAME_LABEL = "kueue.x-k8s.io/queue-name";

/** Kueue label selecting the task-governance priority class. */
export const KUEUE_PRIORITY_CLASS_LABEL = "kueue.x-k8s.io/priority-class";

export interface HyperPodWorkloadProps {
  /**
   * Pin the workload to a HyperPod instance group (matches the
   * `sagemaker.amazonaws.com/instance-group-name` node label). Reference
   * the group through the cluster's attributes —
   * `hyperpod.instanceGroups.workers` — so the workload is connected to
   * the cluster through the resource graph. A plain name string also
   * works.
   */
  instanceGroup?: string | { InstanceGroupName?: string };
  /**
   * Only schedule onto nodes that passed HyperPod health checks
   * (`sagemaker.amazonaws.com/node-health-status: Schedulable`).
   * @default true
   */
  healthyNodesOnly?: boolean;
  /**
   * Submit through HyperPod task governance under this team's quota — pass
   * the `AWS.SageMaker.ComputeQuota` resource. Derives the
   * `hyperpod-ns-<team>` namespace and the Kueue queue label (both
   * materialized by the quota), and orders the workload after it.
   */
  quota?: {
    /** The quota's team name (`ComputeQuota.teamName`). */
    teamName: string;
  };
  /**
   * The task-governance priority class (a `PriorityClass` name from the
   * cluster's `AWS.SageMaker.ClusterSchedulerConfig`).
   */
  priorityClass?: string;
}

/** @internal The `hyperpod-ns-<team>` namespace, when governed. */
export const hyperpodNamespace = (
  hyperpod: HyperPodWorkloadProps | undefined,
): string | undefined =>
  hyperpod?.quota !== undefined
    ? `hyperpod-ns-${hyperpod.quota.teamName}`
    : undefined;

/** @internal Kueue labels for the workload object. */
export const hyperpodWorkloadLabels = (
  hyperpod: HyperPodWorkloadProps | undefined,
): Record<string, string> => ({
  ...(hyperpod?.quota !== undefined
    ? {
        [KUEUE_QUEUE_NAME_LABEL]: `hyperpod-ns-${hyperpod.quota.teamName}-localqueue`,
      }
    : {}),
  ...(hyperpod?.priorityClass !== undefined
    ? { [KUEUE_PRIORITY_CLASS_LABEL]: `${hyperpod.priorityClass}-priority` }
    : {}),
});

/** @internal The instance-group name from either reference form. */
const instanceGroupName = (
  group: string | { InstanceGroupName?: string } | undefined,
): string | undefined =>
  typeof group === "string" ? group : group?.InstanceGroupName;

/** @internal Node selector pinning pods onto HyperPod nodes. */
export const hyperpodNodeSelector = (
  hyperpod: HyperPodWorkloadProps | undefined,
): Record<string, string> | undefined => {
  if (hyperpod === undefined) return undefined;
  const group = instanceGroupName(hyperpod.instanceGroup);
  return {
    ...(hyperpod.healthyNodesOnly !== false
      ? { [HYPERPOD_NODE_HEALTH_LABEL]: "Schedulable" }
      : {}),
    ...(group !== undefined ? { [HYPERPOD_INSTANCE_GROUP_LABEL]: group } : {}),
  };
};
