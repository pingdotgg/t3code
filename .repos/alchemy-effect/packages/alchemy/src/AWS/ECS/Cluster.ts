import * as ecs from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type ClusterName = string;
export type ClusterArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:cluster/${ClusterName}`;

export interface ClusterProps {
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * ECS cluster settings such as container insights.
   */
  settings?: ecs.ClusterSetting[];
  /**
   * Cluster configuration such as execute command logging.
   */
  configuration?: ecs.ClusterConfiguration;
  /**
   * Optional capacity providers associated with the cluster.
   */
  capacityProviders?: string[];
  /**
   * Default capacity provider strategy for the cluster.
   */
  defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
  /**
   * Optional Service Connect defaults for the cluster.
   */
  serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
  /**
   * User-defined tags to apply to the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.ECS.Cluster",
  ClusterProps,
  {
    /** The ARN of the cluster. */
    clusterArn: ClusterArn;
    /** The name of the cluster. */
    clusterName: ClusterName;
    /** The current status of the cluster, e.g. `ACTIVE`. */
    status: string;
    /** The cluster settings, e.g. Container Insights. */
    settings: ecs.ClusterSetting[];
    /** The execute-command configuration of the cluster. */
    configuration?: ecs.ClusterConfiguration;
    /** The capacity providers associated with the cluster. */
    capacityProviders: string[];
    /** The default capacity provider strategy for the cluster. */
    defaultCapacityProviderStrategy: ecs.CapacityProviderStrategyItem[];
    /** The default Service Connect namespace. */
    serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
    /** The tags attached to the cluster. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECS cluster for running tasks and services.
 * @resource
 * @section Creating Clusters
 * @example Default Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.ECS.Cluster");

class ClusterStillActive extends Data.TaggedError("ClusterStillActive")<{
  readonly cluster: string;
  readonly status: string | undefined;
}> {}

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({
          key,
          value,
        }));

      const toClusterName = (
        id: string,
        props: { clusterName?: string } = {},
      ) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const applyCapacityProviders = Effect.fn(function* ({
        cluster,
        capacityProviders,
        defaultCapacityProviderStrategy,
      }: {
        cluster: string;
        capacityProviders?: string[];
        defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
      }) {
        if (
          capacityProviders !== undefined ||
          defaultCapacityProviderStrategy !== undefined
        ) {
          yield* ecs.putClusterCapacityProviders({
            cluster,
            capacityProviders: capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              defaultCapacityProviderStrategy ?? [],
          });
        }
      });

      return {
        stables: ["clusterArn", "clusterName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toClusterName(id, olds ?? {})) !==
            (yield* toClusterName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName =
            output?.clusterName ?? (yield* toClusterName(id, olds ?? {}));
          const described = yield* ecs.describeClusters({
            clusters: [output?.clusterArn ?? clusterName],
            include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
          });
          const cluster = described.clusters?.[0];
          // ECS deletion is a transition to INACTIVE. AWS may continue to
          // return an inactive cluster from DescribeClusters for a while, but
          // it is no longer a usable resource and must not be resurrected in
          // state during refresh.
          if (!cluster?.clusterArn || cluster.status === "INACTIVE") {
            return undefined;
          }
          return {
            clusterArn: cluster.clusterArn as ClusterArn,
            clusterName: cluster.clusterName!,
            status: cluster.status ?? "ACTIVE",
            settings: cluster.settings ?? [],
            configuration: cluster.configuration,
            capacityProviders: cluster.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              cluster.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: cluster.serviceConnectDefaults?.namespace
              ? { namespace: cluster.serviceConnectDefaults.namespace }
              : undefined,
            tags: output?.tags ?? {},
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate every cluster ARN in the account/region, paginating
            // listClusters exhaustively.
            const arns = yield* ecs.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusterArns ?? []),
              ),
            );
            if (arns.length === 0) {
              return [];
            }
            // describeClusters accepts at most 100 clusters per call; batch.
            const batches: string[][] = [];
            for (let i = 0; i < arns.length; i += 100) {
              batches.push(arns.slice(i, i + 100));
            }
            const described = yield* Effect.forEach(
              batches,
              (clusters) =>
                ecs
                  .describeClusters({
                    clusters,
                    include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
                  })
                  .pipe(Effect.map((res) => res.clusters ?? [])),
              { concurrency: 5 },
            );
            return described.flat().flatMap((cluster) => {
              // DeleteCluster does not immediately erase a cluster. Inactive
              // clusters can remain discoverable according to the ECS API,
              // so exclude that terminal state from nuke/provider inventory.
              if (!cluster.clusterArn || cluster.status === "INACTIVE") {
                return [];
              }
              const tags = Object.fromEntries(
                (cluster.tags ?? [])
                  .filter(
                    (t): t is { key: string; value: string } =>
                      typeof t.key === "string" && typeof t.value === "string",
                  )
                  .map((t) => [t.key, t.value]),
              );
              return [
                {
                  clusterArn: cluster.clusterArn as ClusterArn,
                  clusterName: cluster.clusterName!,
                  status: cluster.status ?? "ACTIVE",
                  settings: cluster.settings ?? [],
                  configuration: cluster.configuration,
                  capacityProviders: cluster.capacityProviders ?? [],
                  defaultCapacityProviderStrategy:
                    cluster.defaultCapacityProviderStrategy ?? [],
                  serviceConnectDefaults: cluster.serviceConnectDefaults
                    ?.namespace
                    ? { namespace: cluster.serviceConnectDefaults.namespace }
                    : undefined,
                  tags,
                },
              ];
            });
          }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const clusterName = yield* toClusterName(id, news);
          const clusterArn =
            `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}` as ClusterArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live cloud state.
          let described = yield* ecs.describeClusters({
            clusters: [clusterArn],
            include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
          });
          let cluster = described.clusters?.find(
            (c) =>
              c.clusterName === clusterName &&
              (c.status === "ACTIVE" || c.status === "PROVISIONING"),
          );

          // Ensure — create if missing. ECS createCluster is idempotent for
          // identical params and returns the existing cluster on conflict;
          // we always sync below regardless.
          if (!cluster?.clusterArn) {
            const created = yield* ecs.createCluster({
              clusterName,
              settings: news.settings,
              configuration: news.configuration,
              serviceConnectDefaults: news.serviceConnectDefaults,
              tags: toEcsTags(desiredTags),
            });
            cluster = created.cluster;
          }

          // Sync cluster config — call updateCluster to converge settings,
          // configuration, and serviceConnectDefaults to desired state.
          yield* ecs.updateCluster({
            cluster: clusterArn,
            settings: news.settings,
            configuration: news.configuration,
            serviceConnectDefaults: news.serviceConnectDefaults,
          });

          // Sync capacity providers — observed ↔ desired.
          yield* applyCapacityProviders({
            cluster: clusterArn,
            capacityProviders: news.capacityProviders,
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy,
          });

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = Object.fromEntries(
            (cluster?.tags ?? [])
              .filter(
                (t): t is { key: string; value: string } =>
                  typeof t.key === "string" && typeof t.value === "string",
              )
              .map((t) => [t.key, t.value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecs.tagResource({
              resourceArn: clusterArn,
              tags: upsert.map((tag) => ({ key: tag.Key, value: tag.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ecs.untagResource({
              resourceArn: clusterArn,
              tagKeys: removed,
            });
          }

          yield* session.note(clusterArn);
          return {
            clusterArn,
            clusterName,
            status: cluster?.status ?? "ACTIVE",
            settings: news.settings ?? [],
            configuration: news.configuration,
            capacityProviders: news.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: news.serviceConnectDefaults,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const cluster = output.clusterArn;

          // Observe mutable associations instead of trusting persisted output:
          // capacity providers can be attached out of band or output can be
          // stale after a prior interrupted reconcile.
          const observedCluster = (yield* ecs.describeClusters({
            clusters: [cluster],
          })).clusters?.find((candidate) => candidate.clusterArn === cluster);

          // A cluster cannot be deleted while it still contains services,
          // running tasks, or registered container instances — empty it
          // first so deletion actually converges instead of silently
          // leaving the cluster behind.

          // 1. Delete services (force skips the scale-to-zero dance).
          const serviceArns = yield* ecs.listServices.pages({ cluster }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.serviceArns ?? []),
            ),
            Effect.catchTag("ClusterNotFoundException", () =>
              Effect.succeed([] as string[]),
            ),
          );
          yield* Effect.forEach(
            serviceArns,
            (service) =>
              ecs.deleteService({ cluster, service, force: true }).pipe(
                Effect.catchTag(
                  ["ServiceNotFoundException", "ClusterNotFoundException"],
                  () => Effect.succeed(undefined),
                ),
                Effect.asVoid,
              ),
            { discard: true },
          );

          // 2. Stop any remaining standalone tasks.
          const taskArns = yield* ecs.listTasks.pages({ cluster }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.taskArns ?? []),
            ),
            Effect.catchTag("ClusterNotFoundException", () =>
              Effect.succeed([] as string[]),
            ),
          );
          yield* Effect.forEach(
            taskArns,
            (task) =>
              ecs.stopTask({ cluster, task, reason: "alchemy delete" }).pipe(
                Effect.catchTag("ClusterNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
                Effect.asVoid,
              ),
            { discard: true },
          );

          // 3. Deregister container instances (EC2 launch type).
          const instanceArns = yield* ecs.listContainerInstances
            .pages({ cluster })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.containerInstanceArns ?? [],
                ),
              ),
              Effect.catchTag("ClusterNotFoundException", () =>
                Effect.succeed([] as string[]),
              ),
            );
          yield* Effect.forEach(
            instanceArns,
            (containerInstance) =>
              ecs
                .deregisterContainerInstance({
                  cluster,
                  containerInstance,
                  force: true,
                })
                .pipe(
                  Effect.catchTag("ClusterNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                  Effect.asVoid,
                ),
            { discard: true },
          );

          // 4. Remove custom capacity-provider associations. A cluster with
          //    an associated provider cannot be deleted even after its
          //    services, tasks, and container instances have drained.
          if (
            (observedCluster?.capacityProviders ?? output.capacityProviders)
              .length > 0
          ) {
            yield* ecs
              .putClusterCapacityProviders({
                cluster,
                capacityProviders: [],
                defaultCapacityProviderStrategy: [],
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "UpdateInProgressException" ||
                    e._tag === "ResourceInUseException",
                  schedule: Schedule.max([
                    Schedule.fixed("3 seconds"),
                    Schedule.recurs(10),
                  ]),
                }),
                Effect.catchTag("ClusterNotFoundException", () => Effect.void),
              );
          }

          // 5. Delete the (now empty) cluster. Draining services/tasks is
          //    asynchronous, so retry the contains-* rejections briefly.
          yield* ecs
            .deleteCluster({
              cluster,
            })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "ClusterContainsServicesException" ||
                  e._tag === "ClusterContainsTasksException" ||
                  e._tag === "ClusterContainsContainerInstancesException" ||
                  e._tag === "ClusterContainsCapacityProviderException" ||
                  e._tag === "UpdateInProgressException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(15),
                ]),
              }),
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
            );

          // DeleteCluster's successful response only means that ECS accepted
          // the transition. Observe the terminal INACTIVE state (or absence)
          // before reporting deletion so dependent teardown and a following
          // nuke pass do not race the cluster lifecycle.
          yield* ecs.describeClusters({ clusters: [cluster] }).pipe(
            Effect.flatMap((response) => {
              const observed = response.clusters?.find(
                (candidate) => candidate.clusterArn === cluster,
              );
              return !observed || observed.status === "INACTIVE"
                ? Effect.void
                : Effect.fail(
                    new ClusterStillActive({
                      cluster,
                      status: observed.status,
                    }),
                  );
            }),
            Effect.retry({
              while: (error) => error instanceof ClusterStillActive,
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(15),
              ]),
            }),
          );
        }),
      };
    }),
  );
