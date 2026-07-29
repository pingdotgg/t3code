import * as finspace from "@distilled.cloud/aws/finspace";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

export type KxClusterStatus = finspace.KxClusterStatus;
export type KxClusterType = finspace.KxClusterType;
export type KxAzMode = finspace.KxAzMode;
export type VpcConfiguration = finspace.VpcConfiguration;
export type CapacityConfiguration = finspace.CapacityConfiguration;
export type CodeConfiguration = finspace.CodeConfiguration;
export type KxCommandLineArgument = finspace.KxCommandLineArgument;
export type KxDatabaseConfiguration = finspace.KxDatabaseConfiguration;
export type KxCacheStorageConfiguration = finspace.KxCacheStorageConfiguration;
export type KxSavedownStorageConfiguration =
  finspace.KxSavedownStorageConfiguration;
export type KxScalingGroupConfiguration = finspace.KxScalingGroupConfiguration;
export type TickerplantLogConfiguration = finspace.TickerplantLogConfiguration;

/**
 * Auto-scaling policy for a dedicated {@link KxCluster}.
 */
export interface AutoScalingConfiguration {
  /** Lowest number of nodes to scale in to. */
  minNodeCount?: number;
  /** Highest number of nodes to scale out to. */
  maxNodeCount?: number;
  /** The metric the auto-scaling policy tracks. */
  autoScalingMetric?: finspace.AutoScalingMetric;
  /** The desired value of the chosen metric. */
  metricTarget?: number;
  /**
   * The cooldown after a scale-in event before another scaling event —
   * e.g. `"5 minutes"`. Sent to AWS as whole seconds.
   */
  scaleInCooldown?: Duration.Input;
  /**
   * The cooldown after a scale-out event before another scaling event —
   * e.g. `"5 minutes"`. Sent to AWS as whole seconds.
   */
  scaleOutCooldown?: Duration.Input;
}

/** Convert the alchemy-facing auto-scaling config to the wire shape (seconds). */
const toWireAutoScaling = (
  config: AutoScalingConfiguration,
): finspace.AutoScalingConfiguration => ({
  minNodeCount: config.minNodeCount,
  maxNodeCount: config.maxNodeCount,
  autoScalingMetric: config.autoScalingMetric,
  metricTarget: config.metricTarget,
  scaleInCooldownSeconds: toWireSeconds(config.scaleInCooldown),
  scaleOutCooldownSeconds: toWireSeconds(config.scaleOutCooldown),
});

export interface KxClusterProps {
  /**
   * Identifier of the kdb environment the cluster runs in. Changing it
   * replaces the cluster.
   */
  environmentId: string;
  /**
   * Name of the kdb cluster. Changing it replaces the cluster.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  clusterName?: string;
  /**
   * The type of cluster — `HDB`, `RDB`, `GATEWAY`, `GP` or `TICKERPLANT`.
   * Changing it replaces the cluster.
   */
  clusterType: KxClusterType;
  /**
   * The kdb release the cluster runs (e.g. `"1.0"`). Changing it replaces
   * the cluster.
   */
  releaseLabel: string;
  /**
   * VPC the cluster network interfaces are placed in. Changing it replaces
   * the cluster.
   */
  vpcConfiguration: VpcConfiguration;
  /**
   * Availability-zone placement mode — `SINGLE` or `MULTI`. Changing it
   * replaces the cluster.
   */
  azMode: KxAzMode;
  /**
   * The availability zone id to place the cluster in (required when
   * `azMode` is `SINGLE`). Changing it replaces the cluster.
   */
  availabilityZoneId?: string;
  /**
   * Dedicated node capacity for the cluster. Mutually exclusive with
   * `scalingGroupConfiguration`. Changing it replaces the cluster.
   */
  capacityConfiguration?: CapacityConfiguration;
  /**
   * Placement on a shared scaling group instead of dedicated capacity.
   * Changing it replaces the cluster.
   */
  scalingGroupConfiguration?: KxScalingGroupConfiguration;
  /**
   * Auto-scaling policy for a dedicated cluster. Changing it replaces the
   * cluster.
   */
  autoScalingConfiguration?: AutoScalingConfiguration;
  /**
   * Temporary savedown storage for an `RDB` cluster. Changing it replaces
   * the cluster.
   */
  savedownStorageConfiguration?: KxSavedownStorageConfiguration;
  /**
   * Databases to mount on the cluster, with optional cache configuration.
   */
  databases?: KxDatabaseConfiguration[];
  /**
   * Cache storage (e.g. `CACHE_1000`) sized for the mounted databases.
   * Changing it replaces the cluster.
   */
  cacheStorageConfigurations?: KxCacheStorageConfiguration[];
  /**
   * Tickerplant log volumes for a `TICKERPLANT` cluster. Changing it
   * replaces the cluster.
   */
  tickerplantLogConfiguration?: TickerplantLogConfiguration;
  /**
   * A description of the cluster.
   */
  description?: string;
  /**
   * The S3 location of the q code to deploy on the cluster.
   */
  code?: CodeConfiguration;
  /**
   * Path (relative to the code root) of the q script run at cluster start.
   */
  initializationScript?: string;
  /**
   * Command-line arguments passed to the kdb process.
   */
  commandLineArguments?: KxCommandLineArgument[];
  /**
   * ARN of the IAM execution role the cluster assumes to access AWS
   * resources.
   */
  executionRole?: string;
  /**
   * Tags to associate with the cluster (applied at creation).
   */
  tags?: Record<string, string>;
}

export interface KxCluster extends Resource<
  "AWS.FinSpace.KxCluster",
  KxClusterProps,
  {
    /**
     * Identifier of the kdb environment the cluster runs in.
     */
    environmentId: string;
    /**
     * The cluster's name.
     */
    clusterName: string;
    /**
     * Current lifecycle status of the cluster.
     */
    status: KxClusterStatus | undefined;
    /**
     * The cluster's type.
     */
    clusterType: KxClusterType | undefined;
    /**
     * The kdb release the cluster runs.
     */
    releaseLabel: string | undefined;
    /**
     * Availability-zone placement mode.
     */
    azMode: KxAzMode | undefined;
  },
  never,
  Providers
> {}

/**
 * A kdb cluster inside an Amazon FinSpace Managed kdb environment — the
 * compute that mounts kdb databases and serves q queries.
 *
 * :::caution
 * Cluster provisioning is slow (tens of minutes) and bills per node-hour
 * while it exists. Live lifecycle tests are gated behind
 * `AWS_TEST_FINSPACE=1`.
 * :::
 * @resource
 * @section Creating kdb Clusters
 * @example HDB Cluster on Dedicated Capacity
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const cluster = yield* AWS.FinSpace.KxCluster("Hdb", {
 *   environmentId: env.environmentId,
 *   clusterType: "HDB",
 *   releaseLabel: "1.0",
 *   azMode: "SINGLE",
 *   availabilityZoneId: "use1-az1",
 *   capacityConfiguration: { nodeType: "kx.s.large", nodeCount: 1 },
 *   vpcConfiguration: {
 *     vpcId: vpc.vpcId,
 *     securityGroupIds: [sg.securityGroupId],
 *     subnetIds: [subnet.subnetId],
 *     ipAddressType: "IP_V4",
 *   },
 *   databases: [{ databaseName: db.databaseName }],
 * });
 * ```
 */
export const KxCluster = Resource<KxCluster>("AWS.FinSpace.KxCluster");

const createClusterName = (
  id: string,
  props: { clusterName?: string | undefined },
) =>
  props.clusterName
    ? Effect.succeed(props.clusterName)
    : createPhysicalName({ id, maxLength: 63 });

const isGone = (status: KxClusterStatus | undefined) =>
  status === "DELETED" || status === "DELETING";

const readCluster = Effect.fn(function* (
  environmentId: string,
  clusterName: string,
) {
  const response = yield* finspace
    .getKxCluster({ environmentId, clusterName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!response || isGone(response.status)) return undefined;
  return response;
});

const toAttributes = (
  cluster: finspace.GetKxClusterResponse,
  environmentId: string,
  clusterName: string,
): KxCluster["Attributes"] => ({
  environmentId,
  clusterName: cluster.clusterName ?? clusterName,
  status: cluster.status,
  clusterType: cluster.clusterType,
  releaseLabel: cluster.releaseLabel,
  azMode: cluster.azMode,
});

/**
 * A cluster still transitioning toward the awaited status — retried by the
 * bounded schedule in {@link waitForClusterStatus}.
 */
class KxClusterNotReady extends Data.TaggedError("KxClusterNotReady")<{
  readonly clusterName: string;
  readonly status: string | undefined;
}> {}

/**
 * A cluster whose asynchronous provisioning converged to a terminal failure
 * status (`CREATE_FAILED` / `DELETE_FAILED`).
 */
export class KxClusterProvisioningFailed extends Data.TaggedError(
  "KxClusterProvisioningFailed",
)<{
  readonly clusterName: string;
  readonly status: string | undefined;
  readonly statusReason: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "KxClusterNotReady",
    // Cluster provisioning is slow (tens of minutes); poll every 20s up to
    // ~40 min.
    schedule: Schedule.max([
      Schedule.spaced("20 seconds"),
      Schedule.recurs(120),
    ]),
  });

const waitForClusterStatus = (
  environmentId: string,
  clusterName: string,
  target: "RUNNING" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const response = yield* finspace
        .getKxCluster({ environmentId, clusterName })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const status = response?.status;
      if (target === "DELETED") {
        if (response === undefined || status === "DELETED") return;
        if (status === "DELETE_FAILED") {
          return yield* Effect.fail(
            new KxClusterProvisioningFailed({
              clusterName,
              status,
              statusReason: response.statusReason,
            }),
          );
        }
        return yield* Effect.fail(
          new KxClusterNotReady({ clusterName, status }),
        );
      }
      if (status === "RUNNING") return;
      if (status === "CREATE_FAILED") {
        return yield* Effect.fail(
          new KxClusterProvisioningFailed({
            clusterName,
            status,
            statusReason: response?.statusReason,
          }),
        );
      }
      // response === undefined right after create is eventual consistency —
      // keep polling on the bounded schedule.
      return yield* Effect.fail(new KxClusterNotReady({ clusterName, status }));
    }),
  );

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const KxClusterProvider = () =>
  Provider.effect(
    KxCluster,
    Effect.gen(function* () {
      return {
        stables: ["environmentId", "clusterName"],
        // Clusters are keyed by their parent kdb environment — there is no
        // account-wide enumeration without an environment id.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const environmentId = output?.environmentId ?? olds?.environmentId;
          if (environmentId === undefined) return undefined;
          const clusterName =
            output?.clusterName ?? (yield* createClusterName(id, olds ?? {}));
          const cluster = yield* readCluster(environmentId, clusterName);
          if (!cluster) return undefined;
          // Clusters have no tag-read surface (no ARN in Get/List responses)
          // — ownership cannot be verified, so a name match is owned.
          return toAttributes(cluster, environmentId, clusterName);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createClusterName(id, olds);
          const newName = yield* createClusterName(id, news);
          // Everything except code/databases/description is fixed at
          // creation.
          if (
            olds.environmentId !== news.environmentId ||
            oldName !== newName ||
            olds.clusterType !== news.clusterType ||
            olds.releaseLabel !== news.releaseLabel ||
            olds.azMode !== news.azMode ||
            olds.availabilityZoneId !== news.availabilityZoneId ||
            !sameJson(olds.vpcConfiguration, news.vpcConfiguration) ||
            !sameJson(olds.capacityConfiguration, news.capacityConfiguration) ||
            !sameJson(
              olds.scalingGroupConfiguration,
              news.scalingGroupConfiguration,
            ) ||
            !sameJson(
              olds.autoScalingConfiguration &&
                toWireAutoScaling(olds.autoScalingConfiguration),
              news.autoScalingConfiguration &&
                toWireAutoScaling(news.autoScalingConfiguration),
            ) ||
            !sameJson(
              olds.savedownStorageConfiguration,
              news.savedownStorageConfiguration,
            ) ||
            !sameJson(
              olds.cacheStorageConfigurations,
              news.cacheStorageConfigurations,
            ) ||
            !sameJson(
              olds.tickerplantLogConfiguration,
              news.tickerplantLogConfiguration,
            ) ||
            olds.executionRole !== news.executionRole
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("FinSpace KxCluster requires props"),
            );
          }
          const environmentId = news.environmentId;
          const clusterName =
            output?.clusterName ?? (yield* createClusterName(id, news));
          const internalTags = yield* createInternalTags(id);
          // One idempotency token per reconcile.
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());

          // Observe — cloud state is authoritative.
          let cluster = yield* readCluster(environmentId, clusterName);

          // Ensure — create if missing (tolerating a Conflict race), then
          // wait for RUNNING.
          if (cluster === undefined) {
            yield* finspace
              .createKxCluster({
                clientToken,
                environmentId,
                clusterName,
                clusterType: news.clusterType,
                releaseLabel: news.releaseLabel,
                vpcConfiguration: news.vpcConfiguration,
                azMode: news.azMode,
                availabilityZoneId: news.availabilityZoneId,
                capacityConfiguration: news.capacityConfiguration,
                scalingGroupConfiguration: news.scalingGroupConfiguration,
                autoScalingConfiguration:
                  news.autoScalingConfiguration &&
                  toWireAutoScaling(news.autoScalingConfiguration),
                savedownStorageConfiguration: news.savedownStorageConfiguration,
                databases: news.databases,
                cacheStorageConfigurations: news.cacheStorageConfigurations,
                tickerplantLogConfiguration: news.tickerplantLogConfiguration,
                clusterDescription: news.description,
                code: news.code,
                initializationScript: news.initializationScript,
                commandLineArguments: news.commandLineArguments,
                executionRole: news.executionRole,
                tags: { ...internalTags, ...news.tags },
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            yield* session.note(`Creating kdb cluster ${clusterName}...`);
            yield* waitForClusterStatus(environmentId, clusterName, "RUNNING");
            cluster = yield* readCluster(environmentId, clusterName);
            if (cluster === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created kdb cluster ${clusterName}`),
              );
            }
          }

          // Sync code configuration — only when the caller manages code and
          // the observed deployment drifted.
          if (
            news.code !== undefined &&
            (!sameJson(news.code, cluster.code) ||
              (news.initializationScript ?? "") !==
                (cluster.initializationScript ?? "") ||
              !sameJson(
                news.commandLineArguments,
                cluster.commandLineArguments,
              ))
          ) {
            yield* finspace.updateKxClusterCodeConfiguration({
              environmentId,
              clusterName,
              clientToken,
              code: news.code,
              initializationScript: news.initializationScript,
              commandLineArguments: news.commandLineArguments,
            });
            yield* session.note(`Updated code on kdb cluster ${clusterName}`);
            yield* waitForClusterStatus(environmentId, clusterName, "RUNNING");
          }

          // Sync mounted databases — only when the caller manages them and
          // the observed set drifted.
          if (
            news.databases !== undefined &&
            !sameJson(news.databases, cluster.databases)
          ) {
            yield* finspace.updateKxClusterDatabases({
              environmentId,
              clusterName,
              clientToken,
              databases: news.databases,
            });
            yield* session.note(
              `Updated databases on kdb cluster ${clusterName}`,
            );
            yield* waitForClusterStatus(environmentId, clusterName, "RUNNING");
          }

          yield* session.note(clusterName);

          const final = yield* readCluster(environmentId, clusterName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled kdb cluster ${clusterName}`),
            );
          }
          return toAttributes(final, environmentId, clusterName);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* finspace
            .deleteKxCluster({
              environmentId: output.environmentId,
              clusterName: output.clusterName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* waitForClusterStatus(
            output.environmentId,
            output.clusterName,
            "DELETED",
          );
        }),
      };
    }),
  );
