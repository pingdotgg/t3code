import * as cloudsupport from "@distilled.cloud/gcp/cloudsupport_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  COLLECTION,
  deleteManagedTopic,
  ensureTopic,
  expandTopic,
  findOwnedSubscription,
  getByName,
  getDeletedByName,
  getTopic,
  isDeleted,
  lastSegment,
  listOwnedSubscriptions,
  listOrganizationParents,
  organizationParent,
  ownedByTopicLabels,
  ownershipLabels,
  parentOfName,
  resolveOrganization,
  sameTopic,
  subscriptionIdOf,
  toPhysicalId,
  toSubscriptionName,
  undeleteSubscription,
} from "./internal.ts";

export type SupportEventSubscriptionProps = {
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the subscription.
   */
  organization?: string;
  /**
   * Resource name
   * `organizations/{organization}/supportEventSubscriptions/{subscription}`
   * or the `{subscription}` id. Server-assigned on create. Immutable —
   * changing it replaces the subscription.
   */
  subscriptionId?: string;
  /**
   * Pub/Sub topic that receives Cloud Support events
   * (`projects/{project}/topics/{topic}` or a topic id). Created with
   * Alchemy ownership labels when omitted. Updating this value patches
   * the subscription in place. The topic must live in the same GCP
   * organization as `organization`.
   */
  pubSubTopic?: string;
};

export type SupportEventSubscription = Resource<
  "GCP.CloudSupport.SupportEventSubscription",
  SupportEventSubscriptionProps,
  {
    /** Full resource name `organizations/{organization}/supportEventSubscriptions/{subscription}`. */
    name: string;
    /** Server-assigned subscription id (last path segment). */
    subscriptionId: string;
    /** Parent resource `organizations/{organization}`. */
    parent: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id (last path segment). */
    organizationId: string;
    /** Project id used when the subscription was reconciled. */
    project: string;
    /** Pub/Sub topic that receives events. */
    pubSubTopic: string | undefined;
    /** Server-reported state (`WORKING`, `FAILING`, `DELETED`). */
    state: string | undefined;
    /** Reason the subscription is failing, if `state` is `FAILING`. */
    failureReason: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 soft-delete timestamp. */
    deleteTime: string | undefined;
    /** RFC3339 purge timestamp. */
    purgeTime: string | undefined;
    /** Whether Alchemy created the Pub/Sub topic. */
    managedTopic: boolean;
  },
  never,
  Providers
>;

/**
 * A Cloud Support event subscription that publishes case events to a
 * Pub/Sub topic.
 *
 * Support event subscriptions have no labels field, so Alchemy stamps
 * ownership onto the destination Pub/Sub topic for `list` / nuke and
 * grants `roles/pubsub.publisher` to
 * `cloud-support-apievents@system.gserviceaccount.com`. Organization and
 * subscription id are identity — changing either replaces the
 * subscription. The Pub/Sub topic updates in place. Creating a
 * subscription requires the Cloud Support API and Cloud Customer Care on
 * the organization.
 *
 * ### Creating a Support Event Subscription
 * **Example:** Generated topic
 * ```typescript
 * const sub = yield* GCP.CloudSupport.SupportEventSubscription("Events", {
 *   organization: "organizations/123",
 * });
 * ```
 *
 * **Example:** Existing Pub/Sub topic
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("SupportEvents", {});
 * const sub = yield* GCP.CloudSupport.SupportEventSubscription("Events", {
 *   organization: "organizations/123",
 *   pubSubTopic: topic.name,
 * });
 * ```
 *
 * ### Updating a Support Event Subscription
 * **Example:** Point at a new topic
 * ```typescript
 * // Same logical id as before; only the topic changes.
 * const sub = yield* GCP.CloudSupport.SupportEventSubscription("Events", {
 *   organization: "organizations/123",
 *   pubSubTopic: otherTopic.name,
 * });
 * ```
 *
 * @resource
 * @category CloudSupport
 */
export const SupportEventSubscription = Resource<SupportEventSubscription>(
  "GCP.CloudSupport.SupportEventSubscription",
);

export class SupportEventSubscriptionNotResolved extends Data.TaggedError(
  "GCP.CloudSupport.SupportEventSubscriptionNotResolved",
)<{
  name: string;
}> {}

const lookupName = (
  parent: string,
  subscriptionId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return existingName;
  }
  if (subscriptionId !== undefined && subscriptionId.length > 0) {
    return toSubscriptionName(parent, subscriptionId);
  }
  return "";
};

const toAttrs = (
  subscription: cloudsupport.SupportEventSubscription,
  project: string,
  managedTopic: boolean,
) => {
  const name = subscription.name ?? "";
  const parent = parentOfName(name);
  const organization = parent.startsWith("organizations/")
    ? parent
    : parent.length > 0
      ? organizationParent(parent)
      : "";
  return {
    name,
    subscriptionId: subscriptionIdOf(name),
    parent: parent || organization,
    organization,
    organizationId: lastSegment(organization),
    project,
    pubSubTopic: subscription.pubSubTopic,
    state: subscription.state,
    failureReason: subscription.failureReason,
    createTime: subscription.createTime,
    updateTime: subscription.updateTime,
    deleteTime: subscription.deleteTime,
    purgeTime: subscription.purgeTime,
    managedTopic,
  };
};

export const SupportEventSubscriptionProvider = () =>
  Provider.succeed(SupportEventSubscription, {
    stables: [
      "name",
      "subscriptionId",
      "parent",
      "organization",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        news.organization !== undefined &&
        previousOrg !== undefined &&
        organizationParent(news.organization) !==
          organizationParent(previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.subscriptionId ?? output?.subscriptionId;
      if (
        previousId !== undefined &&
        news.subscriptionId !== undefined &&
        toSubscriptionName("", news.subscriptionId) !==
          toSubscriptionName("", previousId) &&
        news.subscriptionId !== output?.subscriptionId &&
        news.subscriptionId !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.parent,
      );
      const name = lookupName(
        parent,
        olds?.subscriptionId ?? output?.subscriptionId,
        output?.name,
      );
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* findOwnedSubscription(
          parent,
          id,
          name,
          olds?.pubSubTopic ?? output?.pubSubTopic,
        );
      }
      if (existing === undefined || isDeleted(existing)) return undefined;
      const topic = yield* getTopic(existing.pubSubTopic ?? "");
      const attrs = toAttrs(
        existing,
        env.project,
        output?.managedTopic === true,
      );
      const owned =
        (yield* ownedByTopicLabels(id, topic?.labels)) ||
        output?.name === attrs.name;
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listOrganizationParents();
        const pages = yield* Effect.forEach(parents, listOwnedSubscriptions, {
          concurrency: 2,
        });
        return pages
          .flat()
          .map((subscription) => toAttrs(subscription, env.project, false));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.parent,
      );
      const labels = yield* ownershipLabels(id);
      const managedTopic = news.pubSubTopic === undefined;
      const topicName = news.pubSubTopic
        ? expandTopic(news.pubSubTopic, env.project)
        : expandTopic(
            output?.pubSubTopic ??
              (yield* toPhysicalId(id, undefined, undefined)),
            env.project,
          );

      yield* ensureTopic(topicName, labels);

      const lookup = lookupName(
        parent,
        news.subscriptionId ?? output?.subscriptionId,
        output?.name,
      );
      let current = yield* findOwnedSubscription(parent, id, lookup, topicName);

      if (isDeleted(current) && current?.name) {
        current = (yield* undeleteSubscription(current.name)) ?? current;
        if (isDeleted(current) && current.name) {
          current = (yield* getByName(current.name)) ?? current;
        }
      }

      if (current === undefined || isDeleted(current)) {
        const created = yield* cloudsupport
          .createOrganizationsSupportEventSubscriptions({
            parent,
            body: {
              pubSubTopic: topicName,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedSubscription(parent, id, lookup, topicName),
            ),
          );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getDeletedByName(current.name)) ?? current;
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new SupportEventSubscriptionNotResolved({
          name: lookup || `${parent}/${COLLECTION}`,
        });
      }

      if (isDeleted(current)) {
        current =
          (yield* undeleteSubscription(current.name)) ??
          (yield* getByName(current.name)) ??
          current;
      }

      if (current === undefined || current.name === undefined) {
        return yield* new SupportEventSubscriptionNotResolved({
          name: lookup || `${parent}/${COLLECTION}`,
        });
      }

      const name = current.name;
      if (!sameTopic(current.pubSubTopic, topicName)) {
        current =
          yield* cloudsupport.patchOrganizationsSupportEventSubscriptions({
            name,
            updateMask: "pub_sub_topic",
            body: {
              pubSubTopic: topicName,
            },
          });
      }

      const fresh = (yield* getDeletedByName(name)) ?? current;
      return toAttrs(fresh, env.project, managedTopic);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name =
        output.name || toSubscriptionName(output.parent, output.subscriptionId);
      if (name.length > 0) {
        yield* cloudsupport
          .deleteOrganizationsSupportEventSubscriptions({ name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      if (output.managedTopic === true) {
        yield* deleteManagedTopic(output.pubSubTopic);
      }
    }),
  });
