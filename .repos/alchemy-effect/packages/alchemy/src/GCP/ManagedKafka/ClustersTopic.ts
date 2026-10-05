import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandParent,
  fieldMask,
  fingerprint,
  getTopic,
  listAlchemyClusters,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryTransient,
  rfc1035,
  stringMapOf,
  toPhysicalId,
} from "./internal.ts";

const DEFAULT_PARTITION_COUNT = 1;
const DEFAULT_REPLICATION_FACTOR = 3;

export type ClustersTopicProps = {
  /**
   * Parent cluster. Full name
   * `projects/{project}/locations/{location}/clusters/{cluster}` or the
   * cluster id (combined with `location`). Immutable — changing it
   * replaces the topic.
   */
  cluster: string;
  /**
   * Region used when `cluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Topic id (the `{topic}` segment of `.../clusters/{cluster}/topics/{topic}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the topic.
   */
  topicId?: string;
  /**
   * Partition count. Can only be increased, not decreased.
   * @default 1
   */
  partitionCount?: number;
  /**
   * Replication factor. Immutable — changing it replaces the topic.
   * @default 3
   */
  replicationFactor?: number;
  /**
   * Topic configs that override cluster defaults (`cleanup.policy`,
   * `compression.type`, …).
   */
  configs?: Record<string, string>;
};

export type ClustersTopic = Resource<
  "GCP.ManagedKafka.ClustersTopic",
  ClustersTopicProps,
  {
    /** Full resource name `.../clusters/{cluster}/topics/{topic}`. */
    name: string;
    /** Topic id. */
    topicId: string;
    /** Parent cluster resource name. */
    cluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Partition count. */
    partitionCount: number;
    /** Replication factor. */
    replicationFactor: number;
    /** Topic config overrides. */
    configs: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Kafka topic on a Managed Service for Apache Kafka cluster.
 *
 * Changing `topicId`, `cluster`, `location`, or `replicationFactor`
 * replaces the topic. `partitionCount` can only increase. Configs update
 * in place.
 *
 * ### Creating a Topic
 * **Example:** Generated name
 * ```typescript
 * const topic = yield* GCP.ManagedKafka.ClustersTopic("Events", {
 *   cluster: cluster.name,
 * });
 * ```
 *
 * **Example:** Explicit id, partitions, and configs
 * ```typescript
 * const topic = yield* GCP.ManagedKafka.ClustersTopic("Events", {
 *   cluster: cluster.name,
 *   topicId: "order-events",
 *   partitionCount: 3,
 *   replicationFactor: 3,
 *   configs: { "cleanup.policy": "compact" },
 * });
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const ClustersTopic = Resource<ClustersTopic>(
  "GCP.ManagedKafka.ClustersTopic",
);

export class ClustersTopicNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.ClustersTopicNotResolved",
)<{
  name: string;
}> {}

const clusterOf = (cluster: string, project: string, location: string) =>
  expandParent(cluster, project, location, "clusters");

const resourceName = (cluster: string, topicId: string) =>
  `${cluster}/topics/${topicId}`;

const toAttrs = (topic: kafka.Topic, project: string) => {
  const name = topic.name ?? "";
  const parsed = parseName(name, "topics");
  return {
    name,
    topicId: parsed.id,
    cluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    partitionCount: topic.partitionCount ?? DEFAULT_PARTITION_COUNT,
    replicationFactor: topic.replicationFactor ?? DEFAULT_REPLICATION_FACTOR,
    configs: stringMapOf(topic.configs),
  };
};

export const ClustersTopicProvider = () =>
  Provider.succeed(ClustersTopic, {
    stables: ["name", "topicId", "cluster", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousFactor =
        olds?.replicationFactor ?? output?.replicationFactor;
      const nextFactor = news.replicationFactor ?? previousFactor;
      return replaceOnIdentity({
        previousId: olds?.topicId ?? output?.topicId,
        nextId: news.topicId
          ? rfc1035(news.topicId, "topic")
          : (olds?.topicId ?? output?.topicId),
        previousParent: olds?.cluster ?? output?.cluster,
        nextParent: clusterOf(news.cluster, env.project, location),
        extra:
          previousFactor !== undefined &&
          nextFactor !== undefined &&
          previousFactor !== nextFactor,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const topicId = yield* toPhysicalId(
        id,
        olds?.topicId,
        output?.topicId,
        "topic",
      );
      const cluster =
        olds?.cluster !== undefined
          ? clusterOf(olds.cluster, env.project, location)
          : (output?.cluster ?? "");
      const name =
        output?.name ??
        (cluster.length > 0 ? resourceName(cluster, topicId) : "");
      const existing = yield* getTopic(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined || olds !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* listAlchemyClusters(env.project, env.region);
        const topics = yield* Effect.forEach(
          clusters.filter((cluster) => (cluster.name ?? "").length > 0),
          (cluster: kafka.Cluster) =>
            collectPages(
              kafka.listProjectsLocationsClustersTopics.pages({
                parent: cluster.name!,
                pageSize: 1000,
              }),
              (page) => page.topics,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as kafka.Topic[]),
              ),
            ),
          { concurrency: 4 },
        );
        return topics.flat().map((topic) => toAttrs(topic, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const cluster = clusterOf(news.cluster, env.project, location);
      const topicId = yield* toPhysicalId(
        id,
        news.topicId,
        output?.topicId,
        "topic",
      );
      const name = output?.name ?? resourceName(cluster, topicId);
      const partitionCount = news.partitionCount ?? DEFAULT_PARTITION_COUNT;
      const replicationFactor =
        news.replicationFactor ?? DEFAULT_REPLICATION_FACTOR;
      const configs = news.configs;

      let current = yield* getTopic(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsClustersTopics({
              parent: cluster,
              topicId,
              body: {
                partitionCount,
                replicationFactor,
                configs,
              },
            })
            .pipe(Effect.catchTag("Conflict", () => getTopic(name))),
        );
        current = created ?? undefined;
        // A new topic reads back NotFound (UnknownTopicOrPartition) until its
        // partitions are assigned; block until it is readable.
        if (current !== undefined) {
          current = yield* getTopic(name).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (topic) => topic !== undefined,
              times: 24,
            }),
          );
        }
      }

      if (current === undefined) {
        return yield* new ClustersTopicNotResolved({ name });
      }

      const partitionsChanged =
        (current.partitionCount ?? DEFAULT_PARTITION_COUNT) !== partitionCount;
      const configsChanged =
        fingerprint(stringMapOf(current.configs)) !==
        fingerprint(stringMapOf(configs));

      if (partitionsChanged || configsChanged) {
        current = yield* kafka.patchProjectsLocationsClustersTopics({
          name,
          updateMask: fieldMask([
            partitionsChanged && "partition_count",
            configsChanged && "configs",
          ]),
          body: {
            partitionCount,
            configs,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsClustersTopics({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
