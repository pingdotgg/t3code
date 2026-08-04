import * as eks from "@distilled.cloud/aws/eks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface NodegroupProps {
  /**
   * Name of the EKS cluster that owns this managed node group.
   */
  clusterName: Input<string>;
  /**
   * Name of the managed node group. If omitted, a unique name is generated.
   */
  nodegroupName?: string;
  /**
   * ARN of the IAM role that provides permissions for the node group's worker
   * nodes (the `NodeInstanceRole`). Changing this replaces the node group.
   */
  nodeRole: Input<string>;
  /**
   * Subnet IDs to launch worker nodes into. Changing this replaces the node
   * group.
   */
  subnets: Input<string>[];
  /**
   * EC2 instance types for the node group. Changing this replaces the node
   * group.
   * @default ["t3.medium"]
   */
  instanceTypes?: string[];
  /**
   * Scaling configuration (min/max/desired node counts). Mutable — updated in
   * place via `updateNodegroupConfig`.
   */
  scalingConfig?: eks.NodegroupScalingConfig;
  /**
   * AMI type for the node group's nodes (e.g. `AL2023_x86_64_STANDARD`,
   * `BOTTLEROCKET_x86_64`). Changing this replaces the node group.
   */
  amiType?: eks.AMITypes;
  /**
   * Capacity type for the node group. Changing this replaces the node group.
   * @default "ON_DEMAND"
   */
  capacityType?: eks.CapacityTypes;
  /**
   * Root device disk size in GiB. Changing this replaces the node group.
   */
  diskSize?: number;
  /**
   * Kubernetes labels applied to the nodes. Mutable — reconciled in place.
   */
  labels?: Record<string, string>;
  /**
   * Kubernetes taints applied to the nodes. Mutable — reconciled in place.
   */
  taints?: eks.Taint[];
  /**
   * Node group update configuration (`maxUnavailable` /
   * `maxUnavailablePercentage`). Mutable — updated in place.
   */
  updateConfig?: eks.NodegroupUpdateConfig;
  /**
   * Remote SSH access configuration. Changing this replaces the node group.
   */
  remoteAccess?: eks.RemoteAccessConfig;
  /**
   * Kubernetes version for the node group. Mutable — upgraded in place via
   * `updateNodegroupVersion`.
   */
  version?: string;
  /**
   * AMI release version for the node group. Mutable — upgraded in place.
   */
  releaseVersion?: string;
  /**
   * User-defined tags to apply to the node group.
   */
  tags?: Record<string, string>;
}

export interface Nodegroup extends Resource<
  "AWS.EKS.Nodegroup",
  NodegroupProps,
  {
    /** The name of the node group. */
    nodegroupName: string;
    /** The ARN of the node group. */
    nodegroupArn: string;
    /** The name of the EKS cluster the node group belongs to. */
    clusterName: string;
    /** The node group status (e.g. `CREATING`, `ACTIVE`, `UPDATING`). */
    status: eks.NodegroupStatus;
    /** The capacity type (`ON_DEMAND`, `SPOT`, or `CAPACITY_BLOCK`). */
    capacityType: eks.CapacityTypes | undefined;
    /** The scaling configuration (min/max/desired size). */
    scalingConfig: eks.NodegroupScalingConfig | undefined;
    /** The EC2 instance types the node group launches. */
    instanceTypes: string[];
    /** The IDs of the subnets nodes are launched into. */
    subnets: string[];
    /** The AMI type of the nodes (e.g. `AL2023_x86_64_STANDARD`). */
    amiType: eks.AMITypes | undefined;
    /** The ARN of the IAM role attached to the nodes. */
    nodeRole: string;
    /** The Kubernetes labels applied to nodes in the group. */
    labels: Record<string, string>;
    /** The Kubernetes taints applied to nodes in the group. */
    taints: eks.Taint[];
    /** The root device disk size in GiB, when not using a launch template. */
    diskSize: number | undefined;
    /** The Kubernetes version of the node group. */
    version: string | undefined;
    /** The AMI release version of the node group. */
    releaseVersion: string | undefined;
    /** The rolling-update configuration (max unavailable). */
    updateConfig: eks.NodegroupUpdateConfig | undefined;
    /** The tags applied to the node group. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon EKS managed node group — an EC2 Auto Scaling group of worker nodes
 * managed by EKS for a cluster.
 *
 * Managed node groups provide the compute capacity a non-Auto-Mode EKS cluster
 * needs to run pods. Creation is asynchronous (`CREATING` → `ACTIVE`, ~2–5 min)
 * and the provider waits for the group to become `ACTIVE` before returning.
 * Scaling, labels, taints, update config, and version are mutable in place;
 * subnets, instance types, AMI type, disk size, node role, capacity type, and
 * remote access are immutable and force a replacement.
 * @resource
 * @section Creating Node Groups
 * @example Managed Node Group
 * ```typescript
 * const nodes = yield* Nodegroup("AppNodes", {
 *   clusterName: cluster.clusterName,
 *   nodeRole: nodeRole.roleArn,
 *   subnets: network.privateSubnetIds,
 *   instanceTypes: ["t3.medium"],
 *   scalingConfig: { minSize: 1, maxSize: 3, desiredSize: 2 },
 * });
 * ```
 *
 * @example Spot Node Group with Labels and Taints
 * ```typescript
 * const spot = yield* Nodegroup("SpotNodes", {
 *   clusterName: cluster.clusterName,
 *   nodeRole: nodeRole.roleArn,
 *   subnets: network.privateSubnetIds,
 *   capacityType: "SPOT",
 *   instanceTypes: ["t3.large", "t3a.large"],
 *   scalingConfig: { minSize: 0, maxSize: 5, desiredSize: 1 },
 *   labels: { workload: "batch" },
 *   taints: [{ key: "spot", value: "true", effect: "NO_SCHEDULE" }],
 * });
 * ```
 */
export const Nodegroup = Resource<Nodegroup>("AWS.EKS.Nodegroup");

class NodegroupNotReady extends Data.TaggedError("EKS.NodegroupNotReady")<{
  status: eks.NodegroupStatus | undefined;
}> {}

class NodegroupStillExists extends Data.TaggedError(
  "EKS.NodegroupStillExists",
)<{}> {}

class NodegroupUpdateNotComplete extends Data.TaggedError(
  "EKS.NodegroupUpdateNotComplete",
)<{
  status: eks.UpdateStatus | undefined;
}> {}

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const normalizeLabels = (
  labels: Record<string, string | undefined> | undefined,
) =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

// Wait budget: ~10 min at 5s spacing — node groups reach ACTIVE in 2–5 min.
const waitSchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(120),
]);

const taintKey = (taint: eks.Taint) =>
  `${taint.key ?? ""}::${taint.effect ?? ""}`;

/**
 * Compute the `UpdateLabelsPayload` delta between observed and desired labels.
 * Returns `undefined` when there is nothing to change.
 */
const diffLabels = (
  observed: Record<string, string>,
  desired: Record<string, string>,
): eks.UpdateLabelsPayload | undefined => {
  const addOrUpdateLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (observed[key] !== value) {
      addOrUpdateLabels[key] = value;
    }
  }
  const removeLabels = Object.keys(observed).filter((key) => !(key in desired));
  if (
    Object.keys(addOrUpdateLabels).length === 0 &&
    removeLabels.length === 0
  ) {
    return undefined;
  }
  return {
    addOrUpdateLabels:
      Object.keys(addOrUpdateLabels).length > 0 ? addOrUpdateLabels : undefined,
    removeLabels: removeLabels.length > 0 ? removeLabels : undefined,
  };
};

/**
 * Compute the `UpdateTaintsPayload` delta between observed and desired taints,
 * keyed by (key, effect). Returns `undefined` when there is nothing to change.
 */
const diffTaints = (
  observed: eks.Taint[],
  desired: eks.Taint[],
): eks.UpdateTaintsPayload | undefined => {
  const observedByKey = new Map(observed.map((t) => [taintKey(t), t]));
  const desiredByKey = new Map(desired.map((t) => [taintKey(t), t]));

  const addOrUpdateTaints = desired.filter((t) => {
    const existing = observedByKey.get(taintKey(t));
    return !existing || existing.value !== t.value;
  });
  const removeTaints = observed.filter((t) => !desiredByKey.has(taintKey(t)));

  if (addOrUpdateTaints.length === 0 && removeTaints.length === 0) {
    return undefined;
  }
  return {
    addOrUpdateTaints:
      addOrUpdateTaints.length > 0 ? addOrUpdateTaints : undefined,
    removeTaints: removeTaints.length > 0 ? removeTaints : undefined,
  };
};

const scalingConfigChanged = (
  observed: eks.NodegroupScalingConfig | undefined,
  desired: eks.NodegroupScalingConfig | undefined,
) => {
  if (!desired) return false;
  return (
    observed?.minSize !== desired.minSize ||
    observed?.maxSize !== desired.maxSize ||
    observed?.desiredSize !== desired.desiredSize
  );
};

const updateConfigChanged = (
  observed: eks.NodegroupUpdateConfig | undefined,
  desired: eks.NodegroupUpdateConfig | undefined,
) => {
  if (!desired) return false;
  return (
    observed?.maxUnavailable !== desired.maxUnavailable ||
    observed?.maxUnavailablePercentage !== desired.maxUnavailablePercentage ||
    observed?.updateStrategy !== desired.updateStrategy
  );
};

const mapNodegroup = (
  nodegroup: eks.Nodegroup,
  tags: Record<string, string>,
): Nodegroup["Attributes"] => ({
  nodegroupName: nodegroup.nodegroupName!,
  nodegroupArn: nodegroup.nodegroupArn!,
  clusterName: nodegroup.clusterName!,
  status: nodegroup.status ?? "CREATING",
  capacityType: nodegroup.capacityType,
  scalingConfig: nodegroup.scalingConfig,
  instanceTypes: nodegroup.instanceTypes ?? [],
  subnets: nodegroup.subnets ?? [],
  amiType: nodegroup.amiType,
  nodeRole: nodegroup.nodeRole!,
  labels: normalizeLabels(nodegroup.labels),
  taints: nodegroup.taints ?? [],
  diskSize: nodegroup.diskSize,
  version: nodegroup.version,
  releaseVersion: nodegroup.releaseVersion,
  updateConfig: nodegroup.updateConfig,
  tags,
});

export const NodegroupProvider = () =>
  Provider.effect(
    Nodegroup,
    Effect.gen(function* () {
      const toNodegroupName = (
        id: string,
        props: { nodegroupName?: string } = {},
      ) =>
        props.nodegroupName
          ? Effect.succeed(props.nodegroupName)
          : createPhysicalName({ id, maxLength: 63 });

      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      const readNodegroup = Effect.fn(function* ({
        clusterName,
        nodegroupName,
      }: {
        clusterName: string;
        nodegroupName: string;
      }) {
        const described = yield* eks
          .describeNodegroup({ clusterName, nodegroupName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const nodegroup = described?.nodegroup;
        if (
          !nodegroup?.nodegroupArn ||
          !nodegroup.nodegroupName ||
          !nodegroup.clusterName ||
          !nodegroup.nodeRole
        ) {
          return undefined;
        }
        return mapNodegroup(nodegroup, normalizeTags(nodegroup.tags));
      });

      const waitForNodegroupActive = (
        clusterName: string,
        nodegroupName: string,
      ) =>
        readNodegroup({ clusterName, nodegroupName }).pipe(
          Effect.flatMap((state) => {
            if (!state) {
              return Effect.fail(new NodegroupNotReady({ status: undefined }));
            }
            if (state.status === "ACTIVE") {
              return Effect.succeed(state);
            }
            if (
              state.status === "CREATE_FAILED" ||
              state.status === "DELETE_FAILED"
            ) {
              return Effect.fail(
                new Error(
                  `EKS node group '${nodegroupName}' entered ${state.status}`,
                ),
              );
            }
            return Effect.fail(new NodegroupNotReady({ status: state.status }));
          }),
          Effect.retry({
            while: (error) => error instanceof NodegroupNotReady,
            schedule: waitSchedule,
          }),
        );

      const waitForNodegroupDeleted = (
        clusterName: string,
        nodegroupName: string,
      ) =>
        readNodegroup({ clusterName, nodegroupName }).pipe(
          Effect.flatMap((state) =>
            state
              ? Effect.fail(new NodegroupStillExists())
              : Effect.succeed(undefined),
          ),
          Effect.retry({
            while: (error) => error instanceof NodegroupStillExists,
            schedule: waitSchedule,
          }),
        );

      const waitForUpdate = (
        clusterName: string,
        nodegroupName: string,
        updateId: string,
      ) =>
        eks.describeUpdate({ name: clusterName, nodegroupName, updateId }).pipe(
          Effect.flatMap(({ update }) => {
            if (update?.status === "Successful") {
              return Effect.succeed(update);
            }
            if (update?.status === "Failed" || update?.status === "Cancelled") {
              return Effect.fail(
                new Error(
                  `EKS node group update '${updateId}' failed with status '${update?.status}'`,
                ),
              );
            }
            return Effect.fail(
              new NodegroupUpdateNotComplete({ status: update?.status }),
            );
          }),
          Effect.retry({
            while: (error) => error instanceof NodegroupUpdateNotComplete,
            schedule: waitSchedule,
          }),
        );

      return {
        stables: ["nodegroupArn", "nodegroupName", "clusterName"],
        // Enumerate every node group across the account/region. `listNodegroups`
        // is cluster-scoped, so first enumerate all clusters, list each
        // cluster's node groups, then hydrate each via `describeNodegroup`.
        list: () =>
          Effect.gen(function* () {
            const clusterNames = yield* eks.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusters ?? []),
              ),
            );

            const perCluster = yield* Effect.forEach(
              clusterNames,
              (clusterName) =>
                eks.listNodegroups.pages({ clusterName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.nodegroups ?? []),
                  ),
                  Effect.flatMap((names) =>
                    Effect.forEach(
                      names,
                      (nodegroupName) =>
                        readNodegroup({ clusterName, nodegroupName }),
                      { concurrency: 5 },
                    ),
                  ),
                ),
              { concurrency: 5 },
            );

            return perCluster
              .flat()
              .filter(
                (state): state is Nodegroup["Attributes"] =>
                  state !== undefined,
              );
          }),
        diff: Effect.fn(function* ({ id, olds = {} as NodegroupProps, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toNodegroupName(id, olds)) !==
            (yield* toNodegroupName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }
          if (olds.nodeRole !== news.nodeRole) {
            return { action: "replace" } as const;
          }
          if (
            JSON.stringify(olds.subnets ?? []) !==
            JSON.stringify(news.subnets ?? [])
          ) {
            return { action: "replace" } as const;
          }
          if (
            JSON.stringify(olds.instanceTypes ?? []) !==
            JSON.stringify(news.instanceTypes ?? [])
          ) {
            return { action: "replace" } as const;
          }
          if ((olds.amiType ?? undefined) !== (news.amiType ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((olds.diskSize ?? undefined) !== (news.diskSize ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (
            (olds.capacityType ?? "ON_DEMAND") !==
            (news.capacityType ?? "ON_DEMAND")
          ) {
            return { action: "replace" } as const;
          }
          if (
            JSON.stringify(olds.remoteAccess ?? undefined) !==
            JSON.stringify(news.remoteAccess ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName = (output?.clusterName ??
            (olds?.clusterName as string | undefined)) as string | undefined;
          if (!clusterName) return undefined;
          const nodegroupName =
            output?.nodegroupName ?? (yield* toNodegroupName(id, olds ?? {}));
          const state = yield* readNodegroup({ clusterName, nodegroupName });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clusterName = news.clusterName as string;
          const nodegroupName = yield* toNodegroupName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — cloud state is authoritative.
          let state = yield* readNodegroup({ clusterName, nodegroupName });

          // Ensure — create if missing; tolerate a create race, then wait for
          // the node group to reach ACTIVE before syncing.
          if (!state) {
            yield* eks
              .createNodegroup({
                clusterName,
                nodegroupName,
                nodeRole: news.nodeRole as string,
                subnets: news.subnets as string[],
                instanceTypes: news.instanceTypes,
                scalingConfig: news.scalingConfig,
                amiType: news.amiType,
                capacityType: news.capacityType,
                diskSize: news.diskSize,
                labels: news.labels,
                taints: news.taints,
                updateConfig: news.updateConfig,
                remoteAccess: news.remoteAccess,
                version: news.version,
                releaseVersion: news.releaseVersion,
                tags: desiredTags,
                clientRequestToken: yield* toClientRequestToken(id, "create"),
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () => Effect.void),
              );

            yield* session.note(`Creating EKS node group ${nodegroupName}...`);
            state = yield* waitForNodegroupActive(clusterName, nodegroupName);
          }

          // Sync mutable config (scaling, updateConfig, labels, taints) in a
          // single updateNodegroupConfig call when anything changed.
          const desiredLabels = normalizeLabels(news.labels);
          const labelsDelta = diffLabels(state.labels, desiredLabels);
          const taintsDelta = diffTaints(state.taints, news.taints ?? []);
          const scalingChanged = scalingConfigChanged(
            state.scalingConfig,
            news.scalingConfig,
          );
          const updateCfgChanged = updateConfigChanged(
            state.updateConfig,
            news.updateConfig,
          );
          if (
            labelsDelta ||
            taintsDelta ||
            scalingChanged ||
            updateCfgChanged
          ) {
            const configUpdate = yield* eks.updateNodegroupConfig({
              clusterName,
              nodegroupName,
              scalingConfig: scalingChanged ? news.scalingConfig : undefined,
              updateConfig: updateCfgChanged ? news.updateConfig : undefined,
              labels: labelsDelta,
              taints: taintsDelta,
              clientRequestToken: yield* toClientRequestToken(id, "config"),
            });
            if (configUpdate.update?.id) {
              yield* session.note(
                `Updating EKS node group config ${nodegroupName}...`,
              );
              yield* waitForUpdate(
                clusterName,
                nodegroupName,
                configUpdate.update.id,
              );
              state =
                (yield* waitForNodegroupActive(clusterName, nodegroupName)) ??
                state;
            }
          }

          // Sync version / release version via updateNodegroupVersion.
          if (
            (news.version && state.version !== news.version) ||
            (news.releaseVersion &&
              state.releaseVersion !== news.releaseVersion)
          ) {
            const versionUpdate = yield* eks.updateNodegroupVersion({
              clusterName,
              nodegroupName,
              version: news.version,
              releaseVersion: news.releaseVersion,
              clientRequestToken: yield* toClientRequestToken(id, "version"),
            });
            if (versionUpdate.update?.id) {
              yield* session.note(
                `Updating EKS node group version ${nodegroupName}...`,
              );
              yield* waitForUpdate(
                clusterName,
                nodegroupName,
                versionUpdate.update.id,
              );
              state =
                (yield* waitForNodegroupActive(clusterName, nodegroupName)) ??
                state;
            }
          }

          // Sync tags — diff observed cloud tags against desired.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* eks.tagResource({
              resourceArn: state.nodegroupArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: state.nodegroupArn,
              tagKeys: removed,
            });
          }

          yield* session.note(state.nodegroupArn);

          const final = yield* readNodegroup({ clusterName, nodegroupName });
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `EKS node group '${nodegroupName}' could not be read after reconcile`,
              ),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eks
            .deleteNodegroup({
              clusterName: output.clusterName,
              nodegroupName: output.nodegroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* waitForNodegroupDeleted(
            output.clusterName,
            output.nodegroupName,
          );
        }),
      };
    }),
  );
