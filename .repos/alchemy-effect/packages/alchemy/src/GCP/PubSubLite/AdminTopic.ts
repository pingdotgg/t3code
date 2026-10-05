import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PARTITION_COUNT,
  DEFAULT_PER_PARTITION_BYTES,
  DEFAULT_PUBLISH_MIB,
  DEFAULT_SUBSCRIBE_MIB,
  DEFAULT_ZONE,
  ResourceNotResolved,
  countOf,
  expandName,
  fieldMask,
  getTopic,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedTopics,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseName,
  partitionBody,
  partitionKey,
  regionOf,
  replaceOnIdentity,
  resourceName,
  retentionBody,
  retentionKey,
  retryInUse,
  sameRef,
  toResourceId,
  waitUntilGone,
} from "./internal.ts";

export type TopicPartitionCapacity = {
  /**
   * Publish throughput per partition in MiB/s. Must be between 4 and 16.
   * @default 4
   */
  publishMibPerSec?: number;
  /**
   * Subscribe throughput per partition in MiB/s. Must be between 4 and 32.
   * @default 4
   */
  subscribeMibPerSec?: number;
};

export type TopicPartitionConfig = {
  /**
   * Number of partitions. Must be at least 1. After create, the count
   * can increase but not decrease — shrinking replaces the topic.
   * @default 1
   */
  count?: number | string;
  /**
   * Per-partition throughput. Required unless the topic uses a
   * reservation that supplies capacity.
   */
  capacity?: TopicPartitionCapacity;
};

export type TopicRetentionConfig = {
  /**
   * Provisioned storage per partition, in bytes. The API minimum is
   * 30 GiB (`32212254720`). Older messages are dropped when a partition
   * exceeds this size, regardless of `period`.
   * @default "32212254720"
   */
  perPartitionBytes?: string;
  /**
   * How long a published message is retained (e.g. `"86400s"`). If
   * omitted, messages are retained until `perPartitionBytes` is
   * exhausted.
   */
  period?: string;
};

export type TopicReservationConfig = {
  /**
   * Reservation that supplies this topic's throughput, as a full
   * resource name or reservation id. Regional topics require a
   * reservation in the same region.
   */
  throughputReservation?: string;
};

export type AdminTopicProps = {
  /**
   * Topic id (the `{topic}` segment of
   * `projects/{project}/locations/{location}/topics/{topic}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Pub/Sub Lite has no labels field, so Alchemy stamps
   * ownership into a `+alc.{stack}.{stage}.{id}` suffix. Immutable —
   * changing it replaces the topic.
   */
  topicId?: string;
  /**
   * Zone (`us-central1-a`) or region (`us-central1`). Zonal topics can
   * provision their own partition capacity. Regional topics must attach
   * a reservation. Immutable — changing it replaces the topic.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Partition count and per-partition throughput.
   */
  partitionConfig?: TopicPartitionConfig;
  /**
   * Message retention. `perPartitionBytes` defaults to 30 GiB.
   */
  retentionConfig?: TopicRetentionConfig;
  /**
   * Optional reservation that this topic draws throughput from.
   */
  reservationConfig?: TopicReservationConfig;
};

export type AdminTopic = Resource<
  "GCP.PubSubLite.AdminTopic",
  AdminTopicProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/topics/{topic}`. */
    name: string;
    /** Topic id (last path segment, including the Alchemy ownership suffix). */
    topicId: string;
    /** Project id. */
    project: string;
    /** Zone or region id. */
    location: string;
    /** Partition configuration currently applied. */
    partitionConfig: pubsublite.PartitionConfig | undefined;
    /** Retention configuration currently applied. */
    retentionConfig: pubsublite.RetentionConfig | undefined;
    /** Reservation configuration currently applied. */
    reservationConfig: pubsublite.ReservationConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Pub/Sub Lite topic — a zonal or regional partitioned log.
 *
 * Pub/Sub Lite topics have no labels. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the topic id so
 * `list` / `pnpm nuke:gcp` can find them. `topicId` and `location`
 * replace the topic. Partition count can only increase in place;
 * shrinking it replaces the topic. Capacity, retention, and reservation
 * attachment update in place.
 *
 * ### Creating a Topic
 * **Example:** Zonal topic with generated name
 * ```typescript
 * const topic = yield* GCP.PubSubLite.AdminTopic("Events", {});
 * ```
 *
 * **Example:** Explicit capacity and retention
 * ```typescript
 * const topic = yield* GCP.PubSubLite.AdminTopic("Events", {
 *   location: "us-central1-a",
 *   partitionConfig: {
 *     count: 1,
 *     capacity: { publishMibPerSec: 4, subscribeMibPerSec: 8 },
 *   },
 *   retentionConfig: { perPartitionBytes: "32212254720", period: "86400s" },
 * });
 * ```
 *
 * ### Using a Reservation
 * **Example:** Regional topic attached to a reservation
 * ```typescript
 * const reservation = yield* GCP.PubSubLite.AdminReservation("Capacity", {
 *   location: "us-central1",
 *   throughputCapacity: "4",
 * });
 * const topic = yield* GCP.PubSubLite.AdminTopic("Events", {
 *   location: "us-central1",
 *   reservationConfig: { throughputReservation: reservation.name },
 * });
 * ```
 *
 * @resource
 * @category PubSubLite
 */
export const AdminTopic = Resource<AdminTopic>("GCP.PubSubLite.AdminTopic");

const COLLECTION = "reservations";
const TOPIC_COLLECTION = "topics";

const desiredPartition = (news: AdminTopicProps): pubsublite.PartitionConfig =>
  partitionBody({
    count: news.partitionConfig?.count ?? DEFAULT_PARTITION_COUNT,
    capacity: {
      publishMibPerSec:
        news.partitionConfig?.capacity?.publishMibPerSec ?? DEFAULT_PUBLISH_MIB,
      subscribeMibPerSec:
        news.partitionConfig?.capacity?.subscribeMibPerSec ??
        DEFAULT_SUBSCRIBE_MIB,
    },
  });

const desiredRetention = (news: AdminTopicProps): pubsublite.RetentionConfig =>
  retentionBody({
    perPartitionBytes:
      news.retentionConfig?.perPartitionBytes ?? DEFAULT_PER_PARTITION_BYTES,
    period: news.retentionConfig?.period,
  });

const desiredReservation = (
  news: AdminTopicProps,
  project: string,
  location: string,
): pubsublite.ReservationConfig | undefined => {
  const reservation = news.reservationConfig?.throughputReservation;
  if (reservation === undefined || reservation.length === 0) {
    return news.reservationConfig === undefined
      ? undefined
      : { throughputReservation: undefined };
  }
  return {
    throughputReservation: expandName(
      reservation,
      project,
      regionOf(location),
      COLLECTION,
    ),
  };
};

const toAttrs = (
  topic: pubsublite.Topic,
  project: string,
): AdminTopic["Attributes"] => {
  const name = topic.name ?? "";
  const parsed = parseName(name, TOPIC_COLLECTION);
  return {
    name,
    topicId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_ZONE,
    partitionConfig: topic.partitionConfig,
    retentionConfig: topic.retentionConfig,
    reservationConfig: topic.reservationConfig,
  };
};

export const AdminTopicProvider = () =>
  Provider.succeed(AdminTopic, {
    stables: ["name", "topicId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCount = countOf(
        olds?.partitionConfig?.count ?? output?.partitionConfig?.count,
      );
      const nextCount = countOf(
        news.partitionConfig?.count ??
          olds?.partitionConfig?.count ??
          output?.partitionConfig?.count,
      );
      return replaceOnIdentity({
        previousId: olds?.topicId ?? output?.topicId,
        nextId: news.topicId ?? olds?.topicId ?? output?.topicId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
        extra: nextCount < previousCount,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toResourceId(id, olds?.topicId, output?.topicId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, TOPIC_COLLECTION, topicId);
      const existing = yield* getTopic(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned = yield* ownedByAlchemy(id, attrs.topicId);
      if (owned) return attrs;
      return hasOwnershipMarker(attrs.topicId) ? undefined : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedTopics();
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toResourceId(id, news.topicId, output?.topicId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(
        env.project,
        location,
        TOPIC_COLLECTION,
        topicId,
      );
      const partitionConfig = desiredPartition(news);
      const retentionConfig = desiredRetention(news);
      const reservationConfig = desiredReservation(news, env.project, location);

      let current = yield* getTopic(output?.name ?? name);

      if (current === undefined) {
        const body: pubsublite.Topic = {
          partitionConfig,
          retentionConfig,
        };
        if (reservationConfig?.throughputReservation) {
          body.reservationConfig = reservationConfig;
        }
        const created = yield* pubsublite
          .createAdminProjectsLocationsTopics({
            parent: parentOf(env.project, location),
            topicId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getTopic(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedName = current.name ?? name;
      const reservationChanged =
        reservationConfig !== undefined &&
        !sameRef(
          current.reservationConfig?.throughputReservation,
          reservationConfig.throughputReservation,
        );
      const mask = fieldMask([
        partitionKey(current.partitionConfig) !==
          partitionKey(partitionConfig) && "partitionConfig",
        retentionKey(current.retentionConfig) !==
          retentionKey(retentionConfig) && "retentionConfig",
        reservationChanged && "reservationConfig",
      ]);
      if (mask.length > 0) {
        const body: pubsublite.Topic = {
          name: observedName,
          partitionConfig,
          retentionConfig,
        };
        if (reservationConfig !== undefined) {
          body.reservationConfig = reservationConfig;
        }
        current = yield* pubsublite.patchAdminProjectsLocationsTopics({
          name: observedName,
          updateMask: mask,
          body,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryInUse(
        ignoreMissing(
          pubsublite.deleteAdminProjectsLocationsTopics({
            name: output.name,
          }),
        ),
      );
      yield* waitUntilGone(getTopic(output.name));
    }),
  });
