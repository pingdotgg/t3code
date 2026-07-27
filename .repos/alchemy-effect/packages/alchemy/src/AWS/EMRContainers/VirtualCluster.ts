import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface VirtualClusterContainerProvider {
  /**
   * The name of the underlying EKS cluster. Changing it replaces the virtual
   * cluster.
   */
  id: string;
  /**
   * The container provider type.
   * @default "EKS"
   */
  type?: "EKS";
  /**
   * The namespace registration for the underlying EKS cluster.
   */
  info?: {
    eksInfo: {
      /**
       * The Kubernetes namespace the virtual cluster maps to. Changing it
       * replaces the virtual cluster.
       */
      namespace?: string;
      /**
       * A node label selector restricting which nodes run the jobs.
       */
      nodeLabel?: string;
    };
  };
}

export interface VirtualClusterProps {
  /**
   * Name of the virtual cluster (1-64 characters: letters, digits, `.` `_`
   * `/` `#` `-`). Changing the name replaces the virtual cluster.
   * @default a generated physical name
   */
  virtualClusterName?: string;
  /**
   * The EKS cluster and namespace this virtual cluster maps to. Virtual
   * clusters are immutable — any change replaces the virtual cluster.
   */
  containerProvider: VirtualClusterContainerProvider;
  /**
   * The ID of an EMR containers security configuration to attach. Changing
   * it replaces the virtual cluster.
   */
  securityConfigurationId?: string;
  /**
   * Tags to apply to the virtual cluster. Merged with the internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface VirtualCluster extends Resource<
  "AWS.EMRContainers.VirtualCluster",
  VirtualClusterProps,
  {
    /** The ID of the virtual cluster. */
    virtualClusterId: string;
    /** The name of the virtual cluster. */
    virtualClusterName: string;
    /** The ARN of the virtual cluster. */
    virtualClusterArn: string;
    /** The name of the EKS cluster backing the virtual cluster. */
    eksClusterName: string;
    /** The virtual cluster state (e.g. `RUNNING`, `TERMINATING`). */
    state?: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon EMR on EKS virtual cluster — a registration of a Kubernetes
 * namespace on an EKS cluster as an EMR job-submission target. Virtual
 * clusters consume no resources themselves (no cost while idle); jobs
 * submitted to the virtual cluster run as pods in the mapped namespace.
 *
 * The underlying EKS cluster must grant Amazon EMR on EKS access to the
 * namespace (via EKS access entries when the cluster's authentication mode
 * includes `API`, or the legacy `aws-auth` ConfigMap). Everything except tags
 * is immutable — changes replace the virtual cluster.
 *
 * @resource
 * @section Creating Virtual Clusters
 * @example Register an EKS Namespace with EMR
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const cluster = yield* AWS.EKS.Cluster("Cluster", {
 *   roleArn: clusterRole.roleArn,
 *   resourcesVpcConfig: { subnetIds },
 *   accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
 * });
 *
 * const virtualCluster = yield* AWS.EMRContainers.VirtualCluster("Spark", {
 *   containerProvider: {
 *     id: cluster.clusterName,
 *     info: { eksInfo: { namespace: "emr" } },
 *   },
 * });
 * // virtualCluster.virtualClusterId is passed to StartJobRun
 * ```
 */
export const VirtualCluster = Resource<VirtualCluster>(
  "AWS.EMRContainers.VirtualCluster",
);

export const VirtualClusterProvider = () =>
  Provider.effect(
    VirtualCluster,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { virtualClusterName?: string | undefined },
      ) {
        return (
          props.virtualClusterName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const toContainerProvider = (
        props: VirtualClusterContainerProvider,
      ): emrc.ContainerProvider => ({
        type: props.type ?? "EKS",
        id: props.id,
        info: props.info,
      });

      const toAttributes = (vc: emrc.VirtualCluster) => ({
        virtualClusterId: vc.id!,
        virtualClusterName: vc.name!,
        virtualClusterArn: vc.arn!,
        eksClusterName: vc.containerProvider?.id ?? "",
        state: vc.state,
      });

      const observeById = Effect.fn(function* (id: string) {
        return yield* emrc.describeVirtualCluster({ id }).pipe(
          Effect.map((response) => response.virtualCluster),
          Effect.catchTag(
            ["ResourceNotFoundException", "ValidationException"],
            // a malformed/unknown id is "not present", same as not-found
            () => Effect.succeed(undefined),
          ),
        );
      });

      // Terminated virtual clusters linger in list results; only a RUNNING
      // (or transiently ARRESTED) one with our name is "present".
      const live = (state: string | undefined) =>
        state === "RUNNING" || state === "ARRESTED";

      const observeByName = Effect.fn(function* (name: string) {
        return yield* emrc.listVirtualClusters
          .items({ states: ["RUNNING", "ARRESTED"] })
          .pipe(
            Stream.filter((vc) => vc.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      });

      const observe = Effect.fn(function* (
        id: string | undefined,
        name: string,
      ) {
        const byId = id !== undefined ? yield* observeById(id) : undefined;
        if (byId !== undefined && live(byId.state)) {
          return byId;
        }
        return yield* observeByName(name);
      });

      const syncTags = Effect.fn(function* (
        vc: emrc.VirtualCluster,
        desired: Record<string, string>,
      ) {
        // Diff against OBSERVED cloud tags (adoption may bring foreign tags).
        const observed = Object.fromEntries(
          Object.entries(vc.tags ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const { upsert, removed } = diffTags(observed, desired);
        if (upsert.length > 0) {
          yield* emrc.tagResource({
            resourceArn: vc.arn!,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* emrc.untagResource({
            resourceArn: vc.arn!,
            tagKeys: removed,
          });
        }
      });

      return VirtualCluster.Provider.of({
        stables: [
          "virtualClusterId",
          "virtualClusterName",
          "virtualClusterArn",
          "eksClusterName",
        ],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* emrc.listVirtualClusters
              .pages({ states: ["RUNNING", "ARRESTED"] })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.virtualClusters ?? [])
              .filter(
                (vc) =>
                  vc.id !== undefined &&
                  vc.name !== undefined &&
                  vc.arn !== undefined,
              )
              .map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.virtualClusterName ?? (yield* createName(id, olds ?? {}));
          const vc = yield* observe(output?.virtualClusterId, name);
          if (vc?.id === undefined || vc.arn === undefined) {
            return undefined;
          }
          const attrs = toAttributes(vc);
          return (yield* hasAlchemyTags(id, vc.tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            JSON.stringify(toContainerProvider(olds.containerProvider)) !==
              JSON.stringify(toContainerProvider(news.containerProvider)) ||
            olds.securityConfigurationId !== news.securityConfigurationId
          ) {
            // everything except tags is immutable
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const name =
            output?.virtualClusterName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache
          let vc = yield* observe(output?.virtualClusterId, name);

          // 2. ENSURE — create if missing (synchronous; RUNNING immediately)
          if (vc === undefined) {
            const created = yield* emrc.createVirtualCluster({
              // deterministic per instance: a retried create after a crashed
              // reconcile never double-provisions
              clientToken:
                instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 64) ||
                "alchemy",
              name,
              containerProvider: toContainerProvider(news.containerProvider),
              securityConfigurationId: news.securityConfigurationId,
              tags: desiredTags,
            });
            vc =
              created.id !== undefined
                ? yield* emrc
                    .describeVirtualCluster({ id: created.id })
                    .pipe(Effect.map((r) => r.virtualCluster))
                : yield* observeByName(name);
            if (vc?.id === undefined) {
              return yield* Effect.fail(
                new emrc.ResourceNotFoundException({
                  message: `virtual cluster ${name} not visible after create`,
                }),
              );
            }
          }

          // 3. SYNC TAGS — the only mutable aspect; diff observed vs desired
          yield* syncTags(vc, desiredTags);

          yield* session.note(vc.id!);
          return toAttributes(vc);
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteVirtualCluster is idempotent-by-observation: a terminated
          // or missing virtual cluster reads as "not live" and is skipped
          // (repeat deletes of a terminated id fail with ValidationException).
          const vc = yield* emrc
            .describeVirtualCluster({ id: output.virtualClusterId })
            .pipe(
              Effect.map((response) => response.virtualCluster),
              Effect.catchTag(
                ["ResourceNotFoundException", "ValidationException"],
                () => Effect.succeed(undefined),
              ),
            );
          if (vc === undefined || !live(vc.state)) {
            return;
          }
          yield* emrc
            .deleteVirtualCluster({ id: output.virtualClusterId })
            .pipe(Effect.catchTag("ValidationException", () => Effect.void));
        }),
      });
    }),
  );
