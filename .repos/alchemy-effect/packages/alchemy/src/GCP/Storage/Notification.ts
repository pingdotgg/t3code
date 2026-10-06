import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as serviceusage from "@distilled.cloud/gcp/unstable/serviceusage_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { DeleteNotConfirmed } from "../Errors.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_PAYLOAD_FORMAT = "JSON_API_V1";
const CANONICAL_TOPIC_PREFIX = "//pubsub.googleapis.com/";
const PUBLISHER_ROLE = "roles/pubsub.publisher";

export type NotificationPayloadFormat = "JSON_API_V1" | "NONE";

export type NotificationProps = {
  /**
   * Name of the Cloud Storage bucket this notification is attached to.
   * Immutable — changing it replaces the notification.
   */
  bucketName: string;
  /**
   * Cloud Pub/Sub topic to publish events to. Accepts a topic id, a
   * resource name (`projects/{project}/topics/{topic}`), or the canonical
   * URI (`//pubsub.googleapis.com/projects/{project}/topics/{topic}`).
   * Immutable — changing it replaces the notification.
   */
  topic: string;
  /**
   * Payload included in each Pub/Sub message.
   * @default "JSON_API_V1"
   */
  payloadFormat?: NotificationPayloadFormat;
  /**
   * Event types to publish. Omit (or pass an empty list) to receive every
   * event (`OBJECT_FINALIZE`, `OBJECT_METADATA_UPDATE`, `OBJECT_DELETE`,
   * `OBJECT_ARCHIVE`). Immutable — changing it replaces the notification.
   */
  eventTypes?: string[];
  /**
   * If set, only objects whose names start with this prefix generate
   * notifications. Immutable — changing it replaces the notification.
   */
  objectNamePrefix?: string;
  /**
   * Extra attributes attached to every published Pub/Sub message. Alchemy
   * writes no ownership markers here (they would reach every subscriber);
   * the config is tracked by its server-assigned id. Immutable — changing
   * attributes replaces the notification.
   */
  customAttributes?: Record<string, string>;
};

export type Notification = Resource<
  "GCP.Storage.Notification",
  NotificationProps,
  {
    /** Parent bucket name. */
    bucketName: string;
    /** Server-assigned notification id. */
    notificationId: string;
    /** Canonical Pub/Sub topic URI. */
    topic: string;
    /** Topic id (last path segment). */
    topicId: string;
    /** Project id used when normalizing the topic. */
    project: string;
    /** Payload format (`JSON_API_V1` or `NONE`). */
    payloadFormat: string;
    /** Event types this notification is subscribed to (empty = all). */
    eventTypes: string[];
    /** Object-name prefix filter, if any. */
    objectNamePrefix: string | undefined;
    /** User custom attributes (Alchemy ownership keys stripped). */
    customAttributes: Record<string, string>;
    /** GCS self-link. */
    selfLink: string | undefined;
    /** HTTP etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Storage Pub/Sub notification configuration on a bucket.
 *
 * GCS has no update API for notifications — every user-facing field is
 * immutable and changing it replaces the config. The Cloud Storage
 * service account is granted `roles/pubsub.publisher` on the topic
 * during reconcile so events can actually be published.
 *
 * Notifications carry no labels, and `customAttributes` are delivered on
 * every message, so Alchemy does not stamp ownership markers. `read` finds
 * the config by its recorded id; without one, an identical config on the
 * bucket is reported as unowned.
 *
 * ### Creating a Notification
 * **Example:** Notify on every object event
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const notification = yield* GCP.Storage.Notification("object-events", {
 *   bucketName: bucket.bucketName,
 *   topic: topic.name,
 * });
 * ```
 *
 * **Example:** Filtered events, prefix, and custom attributes
 * ```typescript
 * const notification = yield* GCP.Storage.Notification("uploads", {
 *   bucketName: bucket.bucketName,
 *   topic: topic.name,
 *   payloadFormat: "JSON_API_V1",
 *   eventTypes: ["OBJECT_FINALIZE"],
 *   objectNamePrefix: "uploads/",
 *   customAttributes: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const Notification = Resource<Notification>("GCP.Storage.Notification");

export class NotificationNotResolved extends Data.TaggedError(
  "GCP.Storage.NotificationNotResolved",
)<{
  bucketName: string;
  notificationId?: string;
}> {}

export class NotificationServiceAccountMissing extends Data.TaggedError(
  "GCP.Storage.NotificationServiceAccountMissing",
)<{
  project: string;
}> {}

const topicIdOf = (topic: string) => topic.split("/").pop() ?? topic;

const toCanonicalTopic = (topic: string, project: string) => {
  if (topic.startsWith(CANONICAL_TOPIC_PREFIX)) return topic;
  if (topic.startsWith("projects/")) {
    return `${CANONICAL_TOPIC_PREFIX}${topic}`;
  }
  return `${CANONICAL_TOPIC_PREFIX}projects/${project}/topics/${topic}`;
};

const toPubsubName = (topic: string, project: string) => {
  const canonical = toCanonicalTopic(topic, project);
  return canonical.startsWith(CANONICAL_TOPIC_PREFIX)
    ? canonical.slice(CANONICAL_TOPIC_PREFIX.length)
    : canonical;
};

const topicKey = (topic: string, project: string) =>
  toPubsubName(topic, project);

const userAttributes = (
  attributes: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(attributes));

const sameAttributes = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => {
  const a = left ?? {};
  const b = right ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const normalizeEventTypes = (eventTypes: string[] | undefined) =>
  [...(eventTypes ?? [])].map((event) => event.toUpperCase()).sort();

const sameEventTypes = (
  left: string[] | undefined,
  right: string[] | undefined,
) =>
  normalizeEventTypes(left).join("\0") ===
  normalizeEventTypes(right).join("\0");

const toAttrs = (
  notification: storage.Notification,
  bucketName: string,
  project: string,
) => {
  const topic = notification.topic ?? "";
  return {
    bucketName,
    notificationId: notification.id ?? "",
    topic,
    topicId: topicIdOf(topic),
    project,
    payloadFormat: notification.payload_format ?? DEFAULT_PAYLOAD_FORMAT,
    eventTypes: notification.event_types ?? [],
    objectNamePrefix: notification.object_name_prefix,
    customAttributes: userAttributes(notification.custom_attributes),
    selfLink: notification.selfLink,
    etag: notification.etag,
  };
};

const matchesDesired = (
  notification: storage.Notification,
  news: NotificationProps,
  project: string,
) => {
  const desiredTopic = toCanonicalTopic(news.topic, project);
  const observedTopic = notification.topic ?? "";
  const payloadFormat = news.payloadFormat ?? DEFAULT_PAYLOAD_FORMAT;
  return (
    topicKey(observedTopic, project) === topicKey(desiredTopic, project) &&
    (notification.payload_format ?? DEFAULT_PAYLOAD_FORMAT) === payloadFormat &&
    sameEventTypes(notification.event_types, news.eventTypes) &&
    (notification.object_name_prefix ?? "") === (news.objectNamePrefix ?? "") &&
    sameAttributes(
      userAttributes(notification.custom_attributes),
      toLabels(news.customAttributes),
    )
  );
};

const immutableChanged = (
  news: NotificationProps,
  olds: Partial<NotificationProps> | undefined,
  output: Notification["Attributes"] | undefined,
  project: string,
) => {
  const previousBucket = olds?.bucketName ?? output?.bucketName;
  if (previousBucket !== undefined && news.bucketName !== previousBucket) {
    return true;
  }
  const previousTopic = olds?.topic ?? output?.topic;
  if (
    previousTopic !== undefined &&
    topicKey(news.topic, project) !== topicKey(previousTopic, project)
  ) {
    return true;
  }
  const previousPayload =
    olds?.payloadFormat ?? output?.payloadFormat ?? DEFAULT_PAYLOAD_FORMAT;
  if ((news.payloadFormat ?? DEFAULT_PAYLOAD_FORMAT) !== previousPayload) {
    return true;
  }
  if (
    !sameEventTypes(news.eventTypes, olds?.eventTypes ?? output?.eventTypes)
  ) {
    return true;
  }
  const previousPrefix =
    olds?.objectNamePrefix ?? output?.objectNamePrefix ?? "";
  if ((news.objectNamePrefix ?? "") !== previousPrefix) {
    return true;
  }
  const previousAttrs = olds?.customAttributes ?? output?.customAttributes;
  if (!sameAttributes(toLabels(news.customAttributes), previousAttrs)) {
    return true;
  }
  return false;
};

const getById = (bucketName: string, notificationId: string) =>
  storage
    .getNotifications({
      bucket: bucketName,
      notification: notificationId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnBucket = (bucketName: string) =>
  storage.listNotifications({ bucket: bucketName }).pipe(
    Effect.map((page) => page.items ?? []),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as Array<storage.Notification>),
    ),
  );

/** A config on the bucket identical to the desired one (props match). */
const findMatching = (
  bucketName: string,
  props: NotificationProps,
  project: string,
) =>
  listOnBucket(bucketName).pipe(
    Effect.map((items) =>
      items.find((item) => matchesDesired(item, props, project)),
    ),
  );

const waitUntilGone = (bucketName: string, notificationId: string) =>
  getById(bucketName, notificationId).pipe(
    Effect.map((existing) =>
      existing === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 30,
    }),
    Effect.flatMap((status): Effect.Effect<void, DeleteNotConfirmed> =>
      status === "gone"
        ? Effect.void
        : Effect.fail(
            new DeleteNotConfirmed({
              resource: `${bucketName}/notificationConfigs/${notificationId}`,
            }),
          ),
    ),
  );

const deleteById = (bucketName: string, notificationId: string) =>
  storage
    .deleteNotifications({
      bucket: bucketName,
      notification: notificationId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const ensureGcsServiceIdentity = (project: string, email: string) =>
  Effect.gen(function* () {
    const projectNumber = email.match(/^service-(\d+)@/)?.[1] ?? project;
    const operation = yield* serviceusage
      .generateServiceIdentityServices({
        parent: `projects/${projectNumber}/services/storage.googleapis.com`,
      })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    if (operation === undefined) return;
    yield* waitForOperation(
      operation,
      (name) => serviceusage.getOperations({ name }),
      { budget: "2 minutes", interval: "2 seconds" },
    );
  });

const ensureTopicPublisher = (project: string, topic: string) =>
  Effect.gen(function* () {
    const serviceAccount = yield* storage.getProjectsServiceAccount({
      projectId: project,
    });
    const email = serviceAccount.email_address;
    if (!email) {
      return yield* new NotificationServiceAccountMissing({ project });
    }
    yield* ensureGcsServiceIdentity(project, email);
    const resource = toPubsubName(topic, project);
    const member = `serviceAccount:${email}`;
    const grant = Effect.gen(function* () {
      const policy = yield* pubsub.getIamPolicyProjectsTopics({
        resource,
      });
      const bindings = (policy.bindings ?? []).map((binding) => ({
        ...binding,
        members: [...(binding.members ?? [])],
      }));
      const publisher = bindings.find(
        (binding) => binding.role === PUBLISHER_ROLE,
      );
      if (publisher?.members?.includes(member)) {
        return;
      }
      if (publisher) {
        publisher.members = [...(publisher.members ?? []), member];
      } else {
        bindings.push({ role: PUBLISHER_ROLE, members: [member] });
      }
      yield* pubsub.setIamPolicyProjectsTopics({
        resource,
        body: {
          policy: {
            ...policy,
            bindings,
          },
        },
      });
    });
    yield* grant.pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "Conflict" || error._tag === "IamMemberNotFound",
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
      }),
    );
  });

export const NotificationProvider = () =>
  Provider.succeed(Notification, {
    stables: ["notificationId", "bucketName", "project", "selfLink"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined && olds === undefined) return undefined;
      const env = yield* GcpEnvironment.current;
      if (immutableChanged(news, olds, output, env.project)) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const bucketName = olds?.bucketName ?? output?.bucketName;
      if (!bucketName) return undefined;
      let existing =
        output?.notificationId !== undefined
          ? yield* getById(bucketName, output.notificationId)
          : undefined;
      if (existing === undefined && olds !== undefined) {
        existing = yield* findMatching(bucketName, olds, env.project);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, bucketName, env.project);
      // Configs created before markers were dropped still carry them.
      const owned =
        (existing.id !== undefined && existing.id === output?.notificationId) ||
        (yield* hasAlchemyLabels(id, tagRecord(existing.custom_attributes)));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const buckets = yield* storage.listBuckets
          .items({ project: env.project, maxResults: 1000 })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const pages = yield* Effect.forEach(
          buckets,
          (bucket) => {
            const bucketName = bucket.name;
            if (!bucketName) {
              return Effect.succeed([] as Array<Notification["Attributes"]>);
            }
            // Only configs from before ownership markers were dropped are
            // identifiable; the rest go away with their bucket.
            return listOnBucket(bucketName).pipe(
              Effect.map((items) =>
                items
                  .filter((item) =>
                    Object.keys(item.custom_attributes ?? {}).some((key) =>
                      key.startsWith(ALCHEMY_LABEL_PREFIX),
                    ),
                  )
                  .map((item) => toAttrs(item, bucketName, env.project)),
              ),
            );
          },
          { concurrency: 8 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const bucketName = news.bucketName;
      const payloadFormat = news.payloadFormat ?? DEFAULT_PAYLOAD_FORMAT;
      const canonicalTopic = toCanonicalTopic(news.topic, env.project);
      const desiredAttributes = toLabels(news.customAttributes);

      let current: storage.Notification | undefined;
      if (output?.notificationId) {
        current = yield* getById(
          output.bucketName ?? bucketName,
          output.notificationId,
        );
      }
      if (current === undefined) {
        current = yield* findMatching(bucketName, news, env.project);
      }

      if (current === undefined) {
        yield* ensureTopicPublisher(env.project, canonicalTopic);
        const created = yield* storage
          .insertNotifications({
            bucket: bucketName,
            body: {
              topic: canonicalTopic,
              payload_format: payloadFormat,
              event_types:
                news.eventTypes && news.eventTypes.length > 0
                  ? news.eventTypes
                  : undefined,
              object_name_prefix: news.objectNamePrefix,
              custom_attributes: desiredAttributes,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "NotificationTopicUnavailable",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        current = created;
      }

      if (current === undefined || !current.id) {
        return yield* new NotificationNotResolved({
          bucketName,
          notificationId: output?.notificationId,
        });
      }

      return toAttrs(current, bucketName, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketName = output.bucketName;
      const notificationId = output.notificationId;
      if (!bucketName || !notificationId) return;
      yield* deleteById(bucketName, notificationId);
      yield* waitUntilGone(bucketName, notificationId);
    }),
  });
