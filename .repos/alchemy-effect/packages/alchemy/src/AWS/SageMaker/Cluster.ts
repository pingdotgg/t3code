import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type ClusterStatus = sagemaker.ClusterStatus;

/**
 * The well-known node label carrying the HyperPod instance-group name.
 * HyperPod nodes join the orchestrating EKS cluster as ordinary Kubernetes
 * nodes carrying this label.
 */
export const HYPERPOD_INSTANCE_GROUP_LABEL =
  "sagemaker.amazonaws.com/instance-group-name";

/** The well-known node label carrying HyperPod's node health verdict. */
export const HYPERPOD_NODE_HEALTH_LABEL =
  "sagemaker.amazonaws.com/node-health-status";

/**
 * An instance group surfaced on the cluster's attributes — Kubernetes
 * workloads pin themselves to the group by referencing its
 * {@link ClusterInstanceGroupRef.nodeSelector}.
 */
export interface ClusterInstanceGroupRef {
  /** The group's name (the `sagemaker.amazonaws.com/instance-group-name` node label). */
  InstanceGroupName: string;
  /** The group's instance type (e.g. `ml.g5.xlarge`). */
  InstanceType: string | undefined;
  /** Instances currently in service. */
  CurrentCount: number | undefined;
  /** Instances the group is converging toward. */
  TargetCount: number | undefined;
  /**
   * A Kubernetes node selector pinning pods onto this group's
   * health-checked nodes — pass it to a `Kubernetes.Job` /
   * `Kubernetes.Deployment` through the `podTemplate` escape hatch:
   *
   * ```ts
   * podTemplate: {
   *   spec: { nodeSelector: hyperpod.instanceGroups.workers.nodeSelector },
   * }
   * ```
   */
  nodeSelector: Record<string, string>;
}

/**
 * One instance group's specification, sans name — the group's name is the
 * key in {@link ClusterProps.instanceGroups}.
 */
export type ClusterInstanceGroup = Omit<
  sagemaker.ClusterInstanceGroupSpecification,
  "InstanceGroupName"
>;

/**
 * One restricted instance group's specification, sans name — the group's
 * name is the key in {@link ClusterProps.restrictedInstanceGroups}.
 */
export type ClusterRestrictedInstanceGroup = Omit<
  sagemaker.ClusterRestrictedInstanceGroupSpecification,
  "InstanceGroupName"
>;

export interface ClusterProps {
  /**
   * Name of the HyperPod cluster. Maximum 63 characters, alphanumeric and
   * hyphens.
   * @default ${app}-${stage}-${id}
   */
  clusterName?: string;
  /**
   * The instance groups of the cluster, keyed by group name. Each group
   * specifies its instance type, instance count, lifecycle config (S3 URI
   * + `on_create` script) and execution role.
   *
   * Groups are updated in place; removing a key deletes the group from the
   * cluster. The keys carry through to the cluster's `instanceGroups`
   * attribute, so `hyperpod.instanceGroups.workers` is typed per key.
   */
  instanceGroups?: Record<string, ClusterInstanceGroup>;
  /**
   * Restricted instance groups for HyperPod clusters running Amazon-managed
   * workloads (e.g. Nova model customization), keyed by group name.
   */
  restrictedInstanceGroups?: Record<string, ClusterRestrictedInstanceGroup>;
  /**
   * Shared environment configuration (e.g. FSx for Lustre) for restricted
   * instance groups.
   */
  restrictedInstanceGroupsConfig?: sagemaker.ClusterRestrictedInstanceGroupsConfig;
  /**
   * VPC to launch the cluster's nodes into. Changing the VPC replaces the
   * cluster.
   */
  vpcConfig?: sagemaker.VpcConfig;
  /**
   * The cluster's orchestrator. Set `{ Eks: { ClusterArn } }` to attach the
   * HyperPod cluster to an EKS control plane; defaults to Slurm when
   * omitted.
   */
  orchestrator?: sagemaker.ClusterOrchestrator;
  /**
   * Whether HyperPod automatically replaces faulty nodes.
   * @default "Automatic"
   */
  nodeRecovery?: sagemaker.ClusterNodeRecovery;
  /**
   * Managed tiered storage (memory + local NVMe) configuration for
   * checkpointing.
   */
  tieredStorageConfig?: sagemaker.ClusterTieredStorageConfig;
  /**
   * Set to `"Continuous"` to enable continuous node provisioning, where
   * HyperPod provisions capacity as it becomes available instead of
   * all-or-nothing.
   */
  nodeProvisioningMode?: sagemaker.ClusterNodeProvisioningMode;
  /**
   * ARN of the IAM role HyperPod assumes for cluster-level operations
   * (required for continuous provisioning and autoscaling).
   */
  clusterRole?: string;
  /**
   * Cluster autoscaling configuration (e.g. Karpenter) for EKS-orchestrated
   * clusters.
   */
  autoScaling?: sagemaker.ClusterAutoScalingConfig;
  /**
   * Tags to associate with the cluster. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.SageMaker.Cluster",
  ClusterProps,
  {
    /**
     * The cluster's name.
     */
    clusterName: string;
    /**
     * ARN of the cluster.
     */
    clusterArn: string;
    /**
     * The cluster's status (`InService` once reconciled).
     */
    clusterStatus: ClusterStatus;
    /**
     * ARN of the orchestrating EKS cluster, when EKS-orchestrated.
     */
    orchestratorEksClusterArn: string | undefined;
    /**
     * The cluster's instance groups, keyed by group name. Pin a
     * Kubernetes workload onto a group through the resource graph with
     * its node selector:
     * `hyperpod.instanceGroups.workers.nodeSelector`.
     */
    instanceGroups: Record<string, ClusterInstanceGroupRef>;
  },
  never,
  Providers
> {}

const ClusterResource = Resource<Cluster>("AWS.SageMaker.Cluster");

/**
 * A `Cluster` narrowed to the instance-group keys declared in its props —
 * `hyperpod.instanceGroups.workers` is typed per key, and a typo'd key is
 * a compile error.
 */
export type ClusterOf<Groups> = Omit<Cluster, "instanceGroups"> & {
  instanceGroups: Output.ObjectExpr<
    { [K in keyof Groups]: ClusterInstanceGroupRef },
    never
  >;
};

/**
 * An Amazon SageMaker HyperPod cluster — a resilient, persistent cluster of
 * ML compute for distributed training and inference, orchestrated by Slurm
 * or EKS, with automatic faulty-node recovery and deep health checks.
 *
 * Provisioning a HyperPod cluster takes 10–25 minutes; instance groups are
 * updated in place and removing a group from `instanceGroups` deletes it
 * from the cluster.
 * ### Creating Clusters
 * **Example:** Slurm-Orchestrated Cluster
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const cluster = yield* AWS.SageMaker.Cluster("TrainingCluster", {
 *   instanceGroups: {
 *     controller: {
 *       InstanceType: "ml.t3.medium",
 *       InstanceCount: 1,
 *       ExecutionRole: role.roleArn,
 *       LifeCycleConfig: {
 *         SourceS3Uri: `s3://${bucket.bucketName}/lifecycle`,
 *         OnCreate: "on_create.sh",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** EKS-Orchestrated Cluster
 * ```typescript
 * // The EKS cluster must use the `API` (or `API_AND_CONFIG_MAP`)
 * // authentication mode — pass `accessConfig` explicitly, EKS's own
 * // CONFIG_MAP default is rejected. LifeCycleConfig is required for
 * // EKS-orchestrated instance groups too.
 * const hyperpod = yield* AWS.SageMaker.Cluster("EksHyperPod", {
 *   orchestrator: { Eks: { ClusterArn: eksCluster.clusterArn } },
 *   vpcConfig: {
 *     SecurityGroupIds: [securityGroupId],
 *     Subnets: network.privateSubnetIds,
 *   },
 *   instanceGroups: {
 *     workers: {
 *       InstanceType: "ml.g5.xlarge",
 *       InstanceCount: 2,
 *       ExecutionRole: role.roleArn,
 *       LifeCycleConfig: {
 *         SourceS3Uri: `s3://${bucket.bucketName}/lifecycle`,
 *         OnCreate: "on_create.sh",
 *       },
 *     },
 *   },
 *   nodeRecovery: "Automatic",
 * });
 *
 * // The keys carry through to the attributes — typed per key:
 * const workers = hyperpod.instanceGroups.workers;
 * ```
 *
 * ### Running Workloads (Slurm)
 * **Example:** Submit jobs from the login node over SSM
 * ```sh
 * # Slurm jobs are submitted on the cluster itself. Each node is an SSM
 * # target named sagemaker-cluster:<cluster-id>_<instance-group>-<instance-id>
 * # (list nodes with `aws sagemaker list-cluster-nodes`).
 * aws ssm start-session \
 *   --target sagemaker-cluster:6wl4at0i68c6_controller-i-0123456789abcdef0
 * # then, on the node:
 * sbatch --nodes=4 train.sbatch
 * ```
 *
 * ### Running Workloads (EKS)
 * **Example:** Low level: apply any Kubernetes manifest to the orchestrator
 * ```typescript
 * // HyperPod nodes are ordinary EKS nodes — target them from a raw
 * // manifest (a PyTorchJob CRD, a batch/v1 Job, ...) with the well-known
 * // node labels.
 * const job = yield* AWS.EKS.Manifest("RawTrainJob", {
 *   cluster: eksCluster,
 *   manifest: {
 *     apiVersion: "batch/v1",
 *     kind: "Job",
 *     metadata: { name: "raw-train", namespace: "default" },
 *     spec: {
 *       template: {
 *         spec: {
 *           nodeSelector: {
 *             "sagemaker.amazonaws.com/node-health-status": "Schedulable",
 *             "sagemaker.amazonaws.com/instance-group-name": "workers",
 *           },
 *           containers: [{ name: "train", image: "ghcr.io/acme/train:v3" }],
 *           restartPolicy: "Never",
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** High level: an effectful Job pinned to HyperPod nodes
 * ```typescript
 * // Kubernetes.Job / Kubernetes.Deployment run on HyperPod via the
 * // orchestrating EKS cluster in plain Kubernetes vocabulary — the
 * // HyperPod resources expose the derived values as attributes: the
 * // group's `nodeSelector`, the quota's governed `namespace` and Kueue
 * // `queueName`.
 * const evaluate = yield* Kubernetes.Job(
 *   "Evaluate",
 *   {
 *     cluster: eksCluster,
 *     main: import.meta.url,
 *     namespace: quota.namespace,
 *     labels: {
 *       [AWS.SageMaker.KUEUE_QUEUE_NAME_LABEL]: quota.queueName,
 *       [AWS.SageMaker.KUEUE_PRIORITY_CLASS_LABEL]: "training-priority",
 *     },
 *     podTemplate: {
 *       spec: {
 *         nodeSelector: hyperpod.instanceGroups.workers.nodeSelector,
 *       },
 *     },
 *   },
 *   Effect.gen(function* () {
 *     const putItem = yield* AWS.DynamoDB.PutItem(resultsTable);
 *     return {
 *       run: Effect.gen(function* () {
 *         // evaluation logic; bindings land IAM on the pod-identity role
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
 * );
 * ```
 *
 * ### Task Governance
 * **Example:** Prioritize workloads with a scheduler policy and team quotas
 * ```typescript
 * // Requires the amazon-sagemaker-hyperpod-taskgovernance EKS add-on.
 * const policy = yield* AWS.SageMaker.ClusterSchedulerConfig("Scheduler", {
 *   clusterArn: hyperpod.clusterArn,
 *   schedulerConfig: {
 *     PriorityClasses: [{ Name: "training", Weight: 90 }],
 *     FairShare: "Enabled",
 *   },
 * });
 *
 * // Creates the hyperpod-ns-research namespace + Kueue LocalQueue —
 * // exposed as `quota.namespace` / `quota.queueName` for governed
 * // Kubernetes workloads to reference.
 * const quota = yield* AWS.SageMaker.ComputeQuota("ResearchQuota", {
 *   clusterArn: hyperpod.clusterArn,
 *   computeQuotaTarget: { TeamName: "research", FairShareWeight: 10 },
 *   computeQuotaConfig: {
 *     ComputeQuotaResources: [
 *       { InstanceType: "ml.g5.xlarge", Count: 1 },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Cluster: {
  <
    const Props extends {
      [prop in keyof ClusterProps]: Input<ClusterProps[prop]>;
    },
  >(
    id: string,
    props: Props | Effect.Effect<Props>,
  ): Effect.Effect<
    ClusterOf<NonNullable<Props["instanceGroups"]>>,
    never,
    Providers
  >;
} & typeof ClusterResource = ClusterResource as never;

const createClusterName = (
  id: string,
  props: { clusterName?: string | undefined },
) =>
  props.clusterName
    ? Effect.succeed(props.clusterName)
    : createPhysicalName({ id, maxLength: 63 });

const describeClusterOrUndefined = (name: string) =>
  sagemaker
    .describeCluster({ ClusterName: name })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

const fetchClusterTags = Effect.fn(function* (arn: string) {
  const response = yield* sagemaker
    .listTags({ ResourceArn: arn })
    .pipe(
      Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
    );
  return Object.fromEntries(
    (response?.Tags ?? []).flatMap((tag) =>
      tag.Key !== undefined ? [[tag.Key, tag.Value ?? ""]] : [],
    ),
  );
});

const toAttrs = (
  described: sagemaker.DescribeClusterResponse,
): Cluster["Attributes"] => ({
  clusterName: described.ClusterName ?? "",
  clusterArn: described.ClusterArn,
  clusterStatus: described.ClusterStatus,
  orchestratorEksClusterArn: described.Orchestrator?.Eks?.ClusterArn,
  instanceGroups: Object.fromEntries(
    (described.InstanceGroups ?? []).flatMap((group) =>
      group.InstanceGroupName !== undefined
        ? [
            [
              group.InstanceGroupName,
              {
                InstanceGroupName: group.InstanceGroupName,
                InstanceType: group.InstanceType,
                CurrentCount: group.CurrentCount,
                TargetCount: group.TargetCount,
                nodeSelector: {
                  [HYPERPOD_NODE_HEALTH_LABEL]: "Schedulable",
                  [HYPERPOD_INSTANCE_GROUP_LABEL]: group.InstanceGroupName,
                },
              },
            ],
          ]
        : [],
    ),
  ),
});

/**
 * The cluster is still transitioning toward the awaited state — retried by
 * the bounded wait schedule.
 */
class ClusterNotReady extends Data.TaggedError("ClusterNotReady")<{
  readonly clusterName: string;
  readonly status: string | undefined;
}> {}

/**
 * The cluster converged to the terminal `Failed` status.
 */
export class ClusterFailed extends Data.TaggedError("ClusterFailed")<{
  readonly clusterName: string;
  readonly message: string | undefined;
}> {}

/**
 * The cluster is stuck in `Deleting` because SageMaker's internal teardown
 * cannot proceed — e.g. the instance group's execution role (which HyperPod
 * assumes to delete node ENIs) was deleted or lost its
 * `ec2:DeleteNetworkInterface` / `ec2:DeleteNetworkInterfacePermission`
 * permissions mid-teardown. Retrying `deleteCluster` can never fix this;
 * the role and its permissions must be restored out-of-band, after which
 * SageMaker's own retry completes the deletion within a minute.
 */
export class ClusterTeardownBlocked extends Data.TaggedError(
  "ClusterTeardownBlocked",
)<{
  readonly clusterName: string;
  readonly message: string;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ClusterNotReady",
    // HyperPod cluster provisioning routinely takes 10–25 minutes.
    // Poll 15s up to ~35 min.
    schedule: Schedule.max([
      Schedule.spaced("15 seconds"),
      Schedule.recurs(140),
    ]),
  });

// A freshly created execution role isn't assumable by SageMaker for a few
// seconds (IAM propagation) — createCluster rejects it with a
// ValidationException until it is.
const retryWhileRoleUnassumable = <
  A,
  E extends { readonly _tag: string; readonly message?: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e): boolean =>
      e._tag === "ValidationException" &&
      (e.message?.includes("cannot assume the execution role") ?? false),
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)]),
  });

const waitForCluster = (name: string, target: "InService" | "Gone") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* describeClusterOrUndefined(name);
      if (target === "Gone") {
        if (described === undefined) return;
        // SageMaker's internal teardown deletes node ENIs by assuming the
        // instance group's execution role. If that role (or its EC2
        // permissions) was deleted mid-teardown, every internal retry
        // fails and the cluster stays `Deleting` forever — surface the
        // node's permission failure immediately instead of polling the
        // full wait budget on a delete that can never finish.
        const nodes = yield* sagemaker
          .listClusterNodes({ ClusterName: name })
          .pipe(
            Effect.catchTag("ResourceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        const blocked = (nodes?.ClusterNodeSummaries ?? []).find((node) =>
          node.InstanceStatus?.Message?.includes(
            "does not have permission to perform",
          ),
        );
        if (blocked !== undefined) {
          return yield* Effect.fail(
            new ClusterTeardownBlocked({
              clusterName: name,
              message: blocked.InstanceStatus?.Message ?? "",
            }),
          );
        }
        return yield* Effect.fail(
          new ClusterNotReady({
            clusterName: name,
            status: described.ClusterStatus,
          }),
        );
      }
      if (described?.ClusterStatus === "InService") return;
      if (described?.ClusterStatus === "Failed") {
        return yield* Effect.fail(
          new ClusterFailed({
            clusterName: name,
            message: described.FailureMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new ClusterNotReady({
          clusterName: name,
          status: described?.ClusterStatus,
        }),
      );
    }),
  );

/**
 * The subset of an instance group's specification that `updateCluster`
 * can change and `describeCluster` reports back — used to diff desired
 * groups against observed groups.
 */
const observedGroupIdentity = (
  group: sagemaker.DescribeClusterResponse["InstanceGroups"][number],
) => ({
  count: group.TargetCount ?? group.CurrentCount,
  type: group.InstanceType,
});

const desiredGroupIdentity = (group: ClusterInstanceGroup) => ({
  count: group.InstanceCount,
  type: group.InstanceType,
});

/** Fold the keyed props form into the API's named-array form. */
const toGroupSpecs = <G extends { InstanceGroupName?: string }>(
  groups: Record<string, Omit<G, "InstanceGroupName">> | undefined,
): G[] | undefined =>
  groups === undefined
    ? undefined
    : Object.entries(groups).map(
        ([name, group]) => ({ InstanceGroupName: name, ...group }) as G,
      );

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      return {
        stables: ["clusterName", "clusterArn"],
        // HyperPod's internal teardown deletes node ENIs by assuming the
        // instance group's execution role inside the cluster's VPC —
        // deleting the role or network mid-teardown wedges the cluster in
        // `Deleting` permanently, so nuke must fully delete clusters
        // before touching these types.
        nuke: {
          dependsOn: [
            "AWS.IAM.Role",
            "AWS.IAM.Policy",
            "AWS.IAM.InstanceProfile",
            "AWS.EC2.Vpc",
            "AWS.EC2.Subnet",
            "AWS.EC2.SecurityGroup",
          ],
        },
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* sagemaker.listClusters.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.ClusterSummaries ?? [],
                ),
              ),
            );
            return summaries.flatMap((s) =>
              s.ClusterName !== undefined && s.ClusterArn !== undefined
                ? [
                    {
                      clusterName: s.ClusterName,
                      clusterArn: s.ClusterArn,
                      clusterStatus: s.ClusterStatus ?? "InService",
                      orchestratorEksClusterArn: undefined,
                      instanceGroups: {},
                    },
                  ]
                : [],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.clusterName ?? (yield* createClusterName(id, olds ?? {}));
          const described = yield* describeClusterOrUndefined(name);
          if (!described || described.ClusterStatus === "Deleting") {
            return undefined;
          }
          const attrs = toAttrs(described);
          const tags = yield* fetchClusterTags(attrs.clusterArn);
          return (yield* hasAlchemyTags(id, tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createClusterName(id, olds);
          const newName = yield* createClusterName(id, news);
          // The VPC is fixed at creation — changing it (or the name)
          // replaces the cluster. Everything else updates in place.
          if (
            oldName !== newName ||
            JSON.stringify(olds.vpcConfig) !== JSON.stringify(news.vpcConfig)
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("SageMaker HyperPod Cluster requires props"),
            );
          }
          const name =
            output?.clusterName ?? (yield* createClusterName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let described = yield* describeClusterOrUndefined(name);

          // Ensure — create if missing; tolerate the already-exists race.
          if (described === undefined) {
            yield* sagemaker
              .createCluster({
                ClusterName: name,
                InstanceGroups: toGroupSpecs(news.instanceGroups),
                RestrictedInstanceGroups: toGroupSpecs(
                  news.restrictedInstanceGroups,
                ),
                RestrictedInstanceGroupsConfig:
                  news.restrictedInstanceGroupsConfig,
                VpcConfig: news.vpcConfig,
                Orchestrator: news.orchestrator,
                NodeRecovery: news.nodeRecovery,
                TieredStorageConfig: news.tieredStorageConfig,
                NodeProvisioningMode: news.nodeProvisioningMode,
                ClusterRole: news.clusterRole,
                AutoScaling: news.autoScaling,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                retryWhileRoleUnassumable,
                Effect.catchTag("ResourceInUse", () => Effect.void),
              );
            yield* session.note(
              `Creating HyperPod cluster ${name} (typically 10-25 minutes)...`,
            );
          } else {
            // Sync — diff observed instance groups + mutable settings
            // against desired and apply one update call for the delta.
            const observedGroups = new Map(
              (described.InstanceGroups ?? []).flatMap((g) =>
                g.InstanceGroupName !== undefined
                  ? [[g.InstanceGroupName, observedGroupIdentity(g)]]
                  : [],
              ),
            );
            const desiredGroups = new Map(
              Object.entries(news.instanceGroups ?? {}).map(
                ([groupName, g]) => [groupName, desiredGroupIdentity(g)],
              ),
            );
            const groupsToDelete = [...observedGroups.keys()].filter(
              (groupName) => !desiredGroups.has(groupName),
            );
            const groupsChanged =
              groupsToDelete.length > 0 ||
              [...desiredGroups].some(
                ([groupName, identity]) =>
                  JSON.stringify(observedGroups.get(groupName)) !==
                  JSON.stringify(identity),
              );
            const settingsChanged =
              (news.nodeRecovery !== undefined &&
                news.nodeRecovery !== described.NodeRecovery) ||
              (news.nodeProvisioningMode !== undefined &&
                news.nodeProvisioningMode !== described.NodeProvisioningMode) ||
              (news.tieredStorageConfig !== undefined &&
                JSON.stringify(news.tieredStorageConfig) !==
                  JSON.stringify(described.TieredStorageConfig)) ||
              (news.autoScaling !== undefined &&
                news.autoScaling.Mode !== described.AutoScaling?.Mode);

            if (groupsChanged || settingsChanged) {
              yield* sagemaker
                .updateCluster({
                  ClusterName: name,
                  InstanceGroups: toGroupSpecs(news.instanceGroups),
                  RestrictedInstanceGroups: toGroupSpecs(
                    news.restrictedInstanceGroups,
                  ),
                  RestrictedInstanceGroupsConfig:
                    news.restrictedInstanceGroupsConfig,
                  TieredStorageConfig: news.tieredStorageConfig,
                  NodeRecovery: news.nodeRecovery,
                  InstanceGroupsToDelete:
                    groupsToDelete.length > 0 ? groupsToDelete : undefined,
                  NodeProvisioningMode: news.nodeProvisioningMode,
                  ClusterRole: news.clusterRole,
                  AutoScaling: news.autoScaling,
                })
                .pipe(Effect.catchTag("ResourceNotFound", () => Effect.void));
              yield* session.note(`Updating HyperPod cluster ${name}...`);
            }
          }

          // Converge to InService (provisioning is asynchronous).
          yield* waitForCluster(name, "InService");
          described = yield* describeClusterOrUndefined(name);
          if (described === undefined) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled HyperPod cluster ${name}`),
            );
          }
          const attrs = toAttrs(described);

          // Sync tags — diff against OBSERVED cloud tags.
          const currentTags = yield* fetchClusterTags(attrs.clusterArn);
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* sagemaker.deleteTags({
              ResourceArn: attrs.clusterArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* sagemaker.addTags({
              ResourceArn: attrs.clusterArn,
              Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
            });
          }

          yield* session.note(attrs.clusterArn);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          const described = yield* describeClusterOrUndefined(
            output.clusterName,
          );
          if (described === undefined) return;
          // A cluster mid-create/update rejects deletion with a Conflict —
          // wait for it to settle first, then delete. A cluster stuck in
          // `Failed` (or one that never converges) is still deletable. One
          // already `Deleting` (a previous attempt) skips straight to the
          // Gone wait instead of burning the full InService wait budget.
          if (described.ClusterStatus !== "Deleting") {
            yield* waitForCluster(output.clusterName, "InService").pipe(
              Effect.catchTag(
                ["ClusterFailed", "ClusterNotReady"],
                () => Effect.void,
              ),
            );
            yield* sagemaker
              .deleteCluster({ ClusterName: output.clusterName })
              .pipe(
                Effect.catchTag("ResourceNotFound", () => Effect.void),
                Effect.catchTag("ConflictException", () => Effect.void),
              );
          }
          yield* waitForCluster(output.clusterName, "Gone");
        }),
      };
    }),
  );
