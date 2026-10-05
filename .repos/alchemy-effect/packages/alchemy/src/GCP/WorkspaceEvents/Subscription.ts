import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as we from "@distilled.cloud/gcp/workspaceevents_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ensureTopic,
  expandTopic,
  findSubscription,
  getSubscription,
  getTopic,
  lastSegment,
  listOwnedSubscriptions,
  operationResourceName,
  ownedByWesubLabels,
  sameText,
  sortedStrings,
  subscriptionIdOf,
  toPhysicalId,
  toSubscriptionName,
  updateMaskOf,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  wesubLabels,
} from "./internal.ts";

export type PayloadOptions = {
  /**
   * Whether the event payload includes data about the changed resource.
   * Chat and Drive events only.
   */
  includeResource?: boolean;
  /**
   * Comma-separated fields to include when `includeResource` is true.
   */
  fieldMask?: string;
};

export type DriveOptions = {
  /**
   * Receive events about Drive files that are children of the target
   * folder or shared drive. Immutable — changing it replaces the
   * subscription.
   */
  includeDescendants?: boolean;
};

export type SubscriptionProps = {
  /**
   * Resource name `subscriptions/{subscription}` or the `{subscription}`
   * id. Server-assigned on create. Immutable — changing it replaces the
   * subscription.
   */
  subscriptionId?: string;
  /**
   * Google Workspace resource to monitor, as a full resource name
   * (`//chat.googleapis.com/spaces/{space}`,
   * `//drive.googleapis.com/files/{file}`,
   * `//meet.googleapis.com/spaces/{space}`). Immutable — changing it
   * replaces the subscription.
   */
  targetResource: string;
  /**
   * CloudEvents types to receive about the target resource. Lifecycle
   * events are delivered automatically.
   */
  eventTypes: string[];
  /**
   * Pub/Sub topic that receives events
   * (`projects/{project}/topics/{topic}` or a topic id). Created with
   * Alchemy ownership labels when omitted. Immutable — changing it
   * replaces the subscription. The topic must live in the same project.
   */
  pubsubTopic?: string;
  /**
   * Event payload options. Chat and Drive only. Immutable — changing
   * them replaces the subscription.
   */
  payloadOptions?: PayloadOptions;
  /**
   * Drive-only options. Immutable — changing them replaces the
   * subscription.
   */
  driveOptions?: DriveOptions;
  /**
   * RFC3339 expiration timestamp. Mutually exclusive with `ttl`.
   */
  expireTime?: string;
  /**
   * Time-to-live duration (for example `"86400s"`). Mutually exclusive
   * with `expireTime`. Omitted uses the API maximum.
   */
  ttl?: string;
};

export type Subscription = Resource<
  "GCP.WorkspaceEvents.Subscription",
  SubscriptionProps,
  {
    /** Full resource name `subscriptions/{subscription}`. */
    name: string;
    /** Subscription id (last path segment). */
    subscriptionId: string;
    /** Project id used when the subscription was reconciled. */
    project: string;
    /** Monitored Google Workspace resource. */
    targetResource: string | undefined;
    /** CloudEvents types. */
    eventTypes: string[];
    /** Pub/Sub topic that receives events. */
    pubsubTopic: string | undefined;
    /** Event payload options. */
    payloadOptions: PayloadOptions | undefined;
    /** Drive-only options. */
    driveOptions: DriveOptions | undefined;
    /** RFC3339 expiration timestamp. */
    expireTime: string | undefined;
    /** Subscription state (`ACTIVE`, `SUSPENDED`, `DELETED`). */
    state: string | undefined;
    /** Error that suspended the subscription, if any. */
    suspensionReason: string | undefined;
    /** User who authorized the subscription. */
    authority: string | undefined;
    /** Service account that authorized the subscription. */
    serviceAccountAuthority: string | undefined;
    /** System-assigned unique identifier. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Whether Alchemy created the Pub/Sub topic. */
    managedTopic: boolean;
  },
  never,
  Providers
>;

/**
 * A Google Workspace Events subscription.
 *
 * Subscriptions have no labels field, so Alchemy stamps ownership onto
 * the destination Pub/Sub topic (`alchemy-wesub-*`) for `list` / nuke.
 * `targetResource`, the Pub/Sub topic, payload options, and Drive options
 * are identity — changing them replaces the subscription. Event types and
 * expiration update in place. Creating a subscription requires Workspace
 * Events OAuth scopes for the target resource (Chat, Drive, or Meet).
 *
 * ### Creating a Subscription
 * **Example:** Chat space messages to a Pub/Sub topic
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("ChatEvents", {});
 * const sub = yield* GCP.WorkspaceEvents.Subscription("SpaceEvents", {
 *   targetResource: "//chat.googleapis.com/spaces/SPACE_ID",
 *   eventTypes: ["google.workspace.chat.message.v1.created"],
 *   pubsubTopic: topic.name,
 * });
 * ```
 *
 * **Example:** Generated topic
 * ```typescript
 * const sub = yield* GCP.WorkspaceEvents.Subscription("MeetEvents", {
 *   targetResource: "//meet.googleapis.com/spaces/SPACE_ID",
 *   eventTypes: ["google.workspace.meet.conference.v2.started"],
 * });
 * ```
 *
 * ### Updating a Subscription
 * **Example:** Renew TTL and add an event type
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const sub = yield* GCP.WorkspaceEvents.Subscription("SpaceEvents", {
 *   targetResource: "//chat.googleapis.com/spaces/SPACE_ID",
 *   eventTypes: [
 *     "google.workspace.chat.message.v1.created",
 *     "google.workspace.chat.message.v1.updated",
 *   ],
 *   pubsubTopic: topic.name,
 *   ttl: "86400s",
 * });
 * ```
 *
 * @resource
 * @category WorkspaceEvents
 */
export const Subscription = Resource<Subscription>(
  "GCP.WorkspaceEvents.Subscription",
);

export class SubscriptionNotResolved extends Data.TaggedError(
  "GCP.WorkspaceEvents.SubscriptionNotResolved",
)<{
  name: string;
}> {}

const payloadOf = (
  options: we.PayloadOptions | undefined,
): PayloadOptions | undefined => {
  if (options === undefined) return undefined;
  return {
    includeResource: options.includeResource,
    fieldMask: options.fieldMask,
  };
};

const driveOf = (
  options: we.DriveOptions | undefined,
): DriveOptions | undefined => {
  if (options === undefined) return undefined;
  return { includeDescendants: options.includeDescendants };
};

const toAttrs = (
  subscription: we.Subscription,
  project: string,
  managedTopic: boolean,
) => {
  const name = subscription.name ?? "";
  return {
    name,
    subscriptionId: subscriptionIdOf(name),
    project,
    targetResource: subscription.targetResource,
    eventTypes: subscription.eventTypes ?? [],
    pubsubTopic: subscription.notificationEndpoint?.pubsubTopic,
    payloadOptions: payloadOf(subscription.payloadOptions),
    driveOptions: driveOf(subscription.driveOptions),
    expireTime: subscription.expireTime,
    state: subscription.state,
    suspensionReason: subscription.suspensionReason,
    authority: subscription.authority,
    serviceAccountAuthority: subscription.serviceAccountAuthority,
    uid: subscription.uid,
    createTime: subscription.createTime,
    updateTime: subscription.updateTime,
    managedTopic,
  };
};

const lookupName = (
  subscriptionId: string | undefined,
  existingName: string | undefined,
) => {
  if (subscriptionId !== undefined && subscriptionId.length > 0) {
    return toSubscriptionName(subscriptionId);
  }
  if (existingName !== undefined && existingName.length > 0) {
    return toSubscriptionName(existingName);
  }
  return "";
};

const sameTopic = (left: string | undefined, right: string | undefined) => {
  if (left === undefined || right === undefined) return left === right;
  return left === right || lastSegment(left) === lastSegment(right);
};

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: [
      "name",
      "subscriptionId",
      "project",
      "uid",
      "createTime",
      "targetResource",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.subscriptionId ?? output?.subscriptionId;
      if (
        previousId !== undefined &&
        news.subscriptionId !== undefined &&
        toSubscriptionName(news.subscriptionId) !==
          toSubscriptionName(previousId) &&
        news.subscriptionId !== output?.subscriptionId &&
        toSubscriptionName(news.subscriptionId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousTarget = olds?.targetResource ?? output?.targetResource;
      if (
        previousTarget !== undefined &&
        news.targetResource !== previousTarget
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousTopic = olds?.pubsubTopic ?? output?.pubsubTopic;
      if (
        news.pubsubTopic !== undefined &&
        previousTopic !== undefined &&
        !sameTopic(news.pubsubTopic, previousTopic)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousPayload = olds?.payloadOptions ?? output?.payloadOptions;
      if (
        news.payloadOptions !== undefined &&
        previousPayload !== undefined &&
        (news.payloadOptions.includeResource !==
          previousPayload.includeResource ||
          (news.payloadOptions.fieldMask ?? "") !==
            (previousPayload.fieldMask ?? ""))
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousDrive = olds?.driveOptions ?? output?.driveOptions;
      if (
        news.driveOptions?.includeDescendants !== undefined &&
        previousDrive?.includeDescendants !== undefined &&
        news.driveOptions.includeDescendants !==
          previousDrive.includeDescendants
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = lookupName(
        olds?.subscriptionId ?? output?.subscriptionId,
        output?.name,
      );
      let existing = yield* getSubscription(name);
      if (existing === undefined) {
        existing = yield* findSubscription(
          name,
          olds?.eventTypes ?? output?.eventTypes ?? [],
          olds?.targetResource ?? output?.targetResource,
        );
      }
      if (existing === undefined) return undefined;
      const topic = yield* getTopic(
        existing.notificationEndpoint?.pubsubTopic ?? "",
      );
      const attrs = toAttrs(
        existing,
        env.project,
        output?.managedTopic === true,
      );
      return (yield* ownedByWesubLabels(id, topic?.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const subscriptions = yield* listOwnedSubscriptions();
        return subscriptions.map((subscription) =>
          toAttrs(subscription, env.project, false),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* wesubLabels(id);
      const managedTopic = news.pubsubTopic === undefined;
      const topicName = news.pubsubTopic
        ? expandTopic(news.pubsubTopic, env.project)
        : expandTopic(
            output?.pubsubTopic ??
              (yield* toPhysicalId(
                `${id}-topic`,
                undefined,
                undefined,
                "topic",
                255,
              )),
            env.project,
          );

      yield* ensureTopic(topicName, labels);

      const eventTypes = news.eventTypes;
      const lookup = lookupName(
        news.subscriptionId ?? output?.subscriptionId,
        output?.name,
      );
      let current = yield* findSubscription(
        lookup,
        eventTypes,
        news.targetResource,
      );

      if (current === undefined) {
        const created = yield* we
          .createSubscriptions({
            body: {
              targetResource: news.targetResource,
              eventTypes,
              notificationEndpoint: { pubsubTopic: topicName },
              payloadOptions: news.payloadOptions,
              driveOptions: news.driveOptions,
              expireTime: news.expireTime,
              ttl: news.ttl,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          const settled = yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.succeed(created) : Effect.fail(error),
            ),
          );
          const createdName = operationResourceName(settled) ?? lookup;
          if (createdName.length > 0) {
            current = yield* waitUntilExists(
              getSubscription(createdName),
              createdName,
            );
          }
        }
        if (current === undefined) {
          current = yield* findSubscription(
            lookup,
            eventTypes,
            news.targetResource,
          );
        }
      }

      if (current === undefined) {
        return yield* new SubscriptionNotResolved({
          name: lookup || news.targetResource,
        });
      }

      const name = current.name ?? lookup;
      const eventTypesChanged =
        sortedStrings(current.eventTypes).join(",") !==
        sortedStrings(eventTypes).join(",");
      const expireChanged =
        news.expireTime !== undefined &&
        !sameText(current.expireTime, news.expireTime);
      const ttlChanged =
        news.ttl !== undefined && news.expireTime === undefined;
      const mask = updateMaskOf(
        eventTypesChanged ? "event_types" : undefined,
        expireChanged ? "expire_time" : undefined,
        ttlChanged ? "ttl" : undefined,
      );
      if (mask.length > 0) {
        const patched = yield* we.patchSubscriptions({
          name,
          updateMask: mask,
          body: {
            eventTypes,
            expireTime: news.expireTime,
            ttl: news.ttl,
          },
        });
        yield* waitForOperation(patched);
        current = (yield* getSubscription(name)) ?? current;
      }

      if (current.state === "SUSPENDED") {
        const reactivated = yield* we
          .reactivateSubscriptions({ name, body: {} })
          .pipe(
            Effect.catchTag(["NotFound", "BadRequest", "Conflict"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (reactivated !== undefined) {
          yield* waitForOperation(reactivated);
          current = (yield* getSubscription(name)) ?? current;
        }
      }

      const fresh = (yield* getSubscription(name)) ?? current;
      return toAttrs(fresh, env.project, managedTopic);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name || toSubscriptionName(output.subscriptionId);
      if (name.length > 0) {
        const operation = yield* we
          .deleteSubscriptions({ name, allowMissing: true })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          // NOT_FOUND (5): already gone.
          yield* waitForOperation(operation).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 5 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        yield* waitUntilGone(getSubscription(name), name);
      }
      if (output.managedTopic === true && output.pubsubTopic) {
        yield* pubsub
          .deleteProjectsTopics({ topic: output.pubsubTopic })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }),
  });
