import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_ZONE,
  ResourceNotResolved,
  expandName,
  fieldMask,
  getSubscription,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  lastSegment,
  listOwnedSubscriptions,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  retryInUse,
  sameRef,
  sameText,
  toResourceId,
  waitUntilGone,
} from "./internal.ts";

export type SubscriptionDeliveryConfig = {
  /**
   * When messages become available to subscribers.
   * `DELIVER_IMMEDIATELY` or `DELIVER_AFTER_STORED`.
   */
  deliveryRequirement?:
    | pubsublite.DeliveryConfigDeliveryRequirementEnum
    | (string & {});
};

export type SubscriptionPubSubConfig = {
  /**
   * Destination Pub/Sub topic
   * (`projects/{project}/topics/{topic}`).
   */
  topic?: string;
};

export type SubscriptionExportConfig = {
  /**
   * Desired export state. Only `ACTIVE` and `PAUSED` are settable.
   */
  desiredState?: pubsublite.ExportConfigDesiredStateEnum | (string & {});
  /**
   * Optional Pub/Sub Lite topic that receives messages that cannot be
   * exported. Must be in the same project and location.
   */
  deadLetterTopic?: string;
  /**
   * Export messages to a Pub/Sub topic. User subscriber clients must
   * not connect to an export subscription.
   */
  pubsubConfig?: SubscriptionPubSubConfig;
};

export type AdminSubscriptionProps = {
  /**
   * Subscription id (the `{subscription}` segment of
   * `projects/{project}/locations/{location}/subscriptions/{subscription}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Pub/Sub Lite has no labels field, so Alchemy stamps
   * ownership into a `+alc.{stack}.{stage}.{id}` suffix. Immutable —
   * changing it replaces the subscription.
   */
  subscriptionId?: string;
  /**
   * Zone or region. Must match the topic. If omitted, inferred from
   * `topic` when it is a full resource name, otherwise `us-central1-a`.
   * Immutable — changing it replaces the subscription.
   */
  location?: string;
  /**
   * Topic this subscription reads from. Accepts a full resource name or
   * a topic id. Immutable — changing it replaces the subscription.
   */
  topic: string;
  /**
   * Message delivery settings.
   */
  deliveryConfig?: SubscriptionDeliveryConfig;
  /**
   * Optional export that writes messages to a Pub/Sub topic. User
   * subscribers must not attach to an export subscription.
   */
  exportConfig?: SubscriptionExportConfig;
  /**
   * When true, the new subscription only receives messages published
   * after it is created. Create-only.
   * @default false
   */
  skipBacklog?: boolean;
};

export type AdminSubscription = Resource<
  "GCP.PubSubLite.AdminSubscription",
  AdminSubscriptionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/subscriptions/{subscription}`. */
    name: string;
    /** Subscription id (last path segment, including the Alchemy ownership suffix). */
    subscriptionId: string;
    /** Project id. */
    project: string;
    /** Zone or region id. */
    location: string;
    /** Topic this subscription is attached to. */
    topic: string | undefined;
    /** Delivery settings currently applied. */
    deliveryConfig: pubsublite.DeliveryConfig | undefined;
    /** Export configuration currently applied. */
    exportConfig: pubsublite.ExportConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Pub/Sub Lite subscription — a named consumer of a Lite topic.
 *
 * Pub/Sub Lite subscriptions have no labels. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the
 * subscription id so `list` / `pnpm nuke:gcp` can find them.
 * `subscriptionId`, `location`, and `topic` replace the subscription.
 * Delivery and export settings update in place. `skipBacklog` is
 * create-only.
 *
 * ### Creating a Subscription
 * **Example:** Pull subscription on a topic
 * ```typescript
 * const topic = yield* GCP.PubSubLite.AdminTopic("Events", {});
 * const subscription = yield* GCP.PubSubLite.AdminSubscription("Inbox", {
 *   topic: topic.name,
 * });
 * ```
 *
 * **Example:** Deliver after stored
 * ```typescript
 * const subscription = yield* GCP.PubSubLite.AdminSubscription("Inbox", {
 *   topic: topic.name,
 *   deliveryConfig: { deliveryRequirement: "DELIVER_AFTER_STORED" },
 * });
 * ```
 *
 * ### Exporting to Pub/Sub
 * **Example:** Export subscription
 * ```typescript
 * const lite = yield* GCP.PubSubLite.AdminTopic("Events", {});
 * const classic = yield* GCP.PubSub.Topic("Mirror", {});
 * const exported = yield* GCP.PubSubLite.AdminSubscription("Export", {
 *   topic: lite.name,
 *   exportConfig: {
 *     desiredState: "ACTIVE",
 *     pubsubConfig: { topic: classic.name },
 *   },
 * });
 * ```
 *
 * @resource
 * @category PubSubLite
 */
export const AdminSubscription = Resource<AdminSubscription>(
  "GCP.PubSubLite.AdminSubscription",
);

const COLLECTION = "subscriptions";
const TOPIC_COLLECTION = "topics";

const locationOfTopic = (topic: string, fallback: string) => {
  if (!topic.includes("/locations/")) return fallback;
  return parseName(topic, TOPIC_COLLECTION).location || fallback;
};

const desiredDelivery = (
  news: AdminSubscriptionProps,
): pubsublite.DeliveryConfig | undefined => {
  if (news.deliveryConfig === undefined) return undefined;
  return {
    deliveryRequirement: news.deliveryConfig.deliveryRequirement,
  };
};

const desiredExport = (
  news: AdminSubscriptionProps,
  project: string,
  location: string,
): pubsublite.ExportConfig | undefined => {
  if (news.exportConfig === undefined) return undefined;
  const deadLetter =
    news.exportConfig.deadLetterTopic !== undefined &&
    news.exportConfig.deadLetterTopic.length > 0
      ? expandName(
          news.exportConfig.deadLetterTopic,
          project,
          location,
          TOPIC_COLLECTION,
        )
      : news.exportConfig.deadLetterTopic;
  const pubsubTopic = news.exportConfig.pubsubConfig?.topic;
  return {
    desiredState: news.exportConfig.desiredState,
    deadLetterTopic: deadLetter,
    pubsubConfig:
      pubsubTopic === undefined
        ? news.exportConfig.pubsubConfig
        : {
            topic: pubsubTopic.startsWith("projects/")
              ? pubsubTopic
              : `projects/${project}/topics/${lastSegment(pubsubTopic)}`,
          },
  };
};

const toAttrs = (
  subscription: pubsublite.Subscription,
  project: string,
): AdminSubscription["Attributes"] => {
  const name = subscription.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    subscriptionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_ZONE,
    topic: subscription.topic,
    deliveryConfig: subscription.deliveryConfig,
    exportConfig: subscription.exportConfig,
  };
};

export const AdminSubscriptionProvider = () =>
  Provider.succeed(AdminSubscription, {
    stables: ["name", "subscriptionId", "project", "location", "topic"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousTopic = olds?.topic ?? output?.topic;
      const topicChanged =
        previousTopic !== undefined && !sameRef(previousTopic, news.topic);
      const inferred = locationOfTopic(
        news.topic,
        normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
      );
      return replaceOnIdentity({
        previousId: olds?.subscriptionId ?? output?.subscriptionId,
        nextId:
          news.subscriptionId ?? olds?.subscriptionId ?? output?.subscriptionId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          DEFAULT_ZONE,
        ),
        nextLocation: normalizeLocation(
          news.location ?? inferred,
          DEFAULT_ZONE,
        ),
        extra: topicChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toResourceId(
        id,
        olds?.subscriptionId,
        output?.subscriptionId,
      );
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.topic ? locationOfTopic(olds.topic, DEFAULT_ZONE) : undefined),
        DEFAULT_ZONE,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, subscriptionId);
      const existing = yield* getSubscription(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned = yield* ownedByAlchemy(id, attrs.subscriptionId);
      if (owned) return attrs;
      return hasOwnershipMarker(attrs.subscriptionId)
        ? undefined
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedSubscriptions();
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toResourceId(
        id,
        news.subscriptionId,
        output?.subscriptionId,
      );
      const topicName = expandName(
        news.topic,
        env.project,
        normalizeLocation(
          news.location ??
            output?.location ??
            locationOfTopic(news.topic, DEFAULT_ZONE),
          DEFAULT_ZONE,
        ),
        TOPIC_COLLECTION,
      );
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationOfTopic(topicName, DEFAULT_ZONE),
        DEFAULT_ZONE,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        subscriptionId,
      );
      const deliveryConfig = desiredDelivery(news);
      const exportConfig = desiredExport(news, env.project, location);

      let current = yield* getSubscription(output?.name ?? name);

      if (current === undefined) {
        const body: pubsublite.Subscription = {
          topic: topicName,
        };
        if (deliveryConfig !== undefined) body.deliveryConfig = deliveryConfig;
        if (exportConfig !== undefined) body.exportConfig = exportConfig;
        const created = yield* pubsublite
          .createAdminProjectsLocationsSubscriptions({
            parent: parentOf(env.project, location),
            subscriptionId,
            skipBacklog: news.skipBacklog,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getSubscription(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedName = current.name ?? name;
      const deliveryChanged =
        deliveryConfig !== undefined &&
        !sameText(
          current.deliveryConfig?.deliveryRequirement,
          deliveryConfig.deliveryRequirement,
        );
      const exportChanged =
        exportConfig !== undefined &&
        !jsonEqual(
          {
            desiredState: exportConfig.desiredState ?? "",
            deadLetterTopic: exportConfig.deadLetterTopic ?? "",
            pubsubTopic: exportConfig.pubsubConfig?.topic ?? "",
          },
          {
            desiredState: current.exportConfig?.desiredState ?? "",
            deadLetterTopic: current.exportConfig?.deadLetterTopic ?? "",
            pubsubTopic: current.exportConfig?.pubsubConfig?.topic ?? "",
          },
        );
      const mask = fieldMask([
        deliveryChanged && "deliveryConfig",
        exportChanged && "exportConfig",
      ]);
      if (mask.length > 0) {
        const body: pubsublite.Subscription = { name: observedName };
        if (deliveryConfig !== undefined) body.deliveryConfig = deliveryConfig;
        if (exportConfig !== undefined) body.exportConfig = exportConfig;
        current = yield* pubsublite.patchAdminProjectsLocationsSubscriptions({
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
          pubsublite.deleteAdminProjectsLocationsSubscriptions({
            name: output.name,
          }),
        ),
      );
      yield* waitUntilGone(getSubscription(output.name));
    }),
  });
