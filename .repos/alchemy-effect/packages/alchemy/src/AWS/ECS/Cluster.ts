import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
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
    clusterArn: ClusterArn;
    clusterName: ClusterName;
    status: string;
    settings: ecs.ClusterSetting[];
    configuration?: ecs.ClusterConfiguration;
    capacityProviders: string[];
    defaultCapacityProviderStrategy: ecs.CapacityProviderStrategyItem[];
    serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECS cluster for running tasks and services.
 *
 * @section Creating Clusters
 * @example Default Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.ECS.Cluster");

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

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
          if (!cluster?.clusterArn) {
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
        reconcile: Effect.fn(function* ({ id, news, session }) {
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
          yield* ecs
            .deleteCluster({
              cluster: output.clusterArn,
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
              Effect.catchTag(
                "ClusterContainsServicesException",
                () => Effect.void,
              ),
              Effect.catchTag(
                "ClusterContainsTasksException",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
