import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { projectNumber } from "../Host.ts";
import { updateIamMembership } from "../IamPolicy.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type SubscriptionRetryPolicy = {
  /**
   * Minimum delay between consecutive deliveries of a given message
   * (e.g. `"10s"`). Must be between 0 and 600 seconds.
   */
  minimumBackoff?: string;
  /**
   * Maximum delay between consecutive deliveries of a given message
   * (e.g. `"600s"`). Must be between 0 and 600 seconds.
   */
  maximumBackoff?: string;
};

export type SubscriptionDeadLetterPolicy = {
  /**
   * Topic that receives dead-lettered messages, as
   * `projects/{project}/topics/{topic}`.
   */
  deadLetterTopic?: string;
  /**
   * Maximum delivery attempts before dead-lettering. Must be between 5 and
   * 100. `0` is treated as `5`.
   */
  maxDeliveryAttempts?: number;
};

export type SubscriptionExpirationPolicy = {
  /**
   * Idle time-to-live (e.g. `"2678400s"` for 31 days). Minimum is 1 day.
   * Omit `ttl` to never expire. If the whole policy is omitted, GCP
   * applies a 31-day default.
   */
  ttl?: string;
};

export type SubscriptionOidcToken = {
  /** Service account email Pub/Sub uses to sign the JWT. */
  serviceAccountEmail?: string;
  /** JWT audience. Defaults to the push endpoint. */
  audience?: string;
};

export type SubscriptionPushConfig = {
  /**
   * HTTPS endpoint that receives pushed messages
   * (e.g. `"https://example.com/push"`).
   */
  pushEndpoint?: string;
  /**
   * Endpoint attributes. The only currently supported key is
   * `x-goog-version` (`v1` / `v1beta1` / `v1beta2`).
   */
  attributes?: Record<string, string>;
  /**
   * Attach an OIDC JWT as `Authorization` on every push.
   */
  oidcToken?: SubscriptionOidcToken;
};

export type SubscriptionProps = {
  /**
   * Subscription id (the `{subscription}` segment of
   * `projects/{project}/subscriptions/{subscription}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Changing it replaces the subscription.
   */
  subscriptionId?: string;
  /**
   * Topic this subscription receives from. Accepts a full resource name
   * (`projects/{project}/topics/{topic}`) or a topic id. Immutable —
   * changing it replaces the subscription.
   */
  topic: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Approximate time Pub/Sub waits for an ack before redelivering, in
   * seconds. Minimum 10, maximum 600. `0` is treated as 10.
   * @default 10
   */
  ackDeadlineSeconds?: number;
  /**
   * Retain acknowledged messages so they can be seeked until they fall
   * out of `messageRetentionDuration`.
   * @default false
   */
  retainAckedMessages?: boolean;
  /**
   * How long to retain unacknowledged messages (e.g. `"86400s"`). Cannot
   * be more than 31 days or less than 10 minutes. Defaults to 7 days.
   */
  messageRetentionDuration?: string;
  /**
   * Deliver messages with the same ordering key in publish order.
   * Immutable — changing it replaces the subscription.
   * @default false
   */
  enableMessageOrdering?: boolean;
  /**
   * Guarantee that an acknowledged message is not redelivered (best
   * effort; distinct publishes of the same payload still get distinct
   * `message_id`s).
   * @default false
   */
  enableExactlyOnceDelivery?: boolean;
  /**
   * Pub/Sub filter language expression. Only matching messages are
   * delivered. Immutable — changing it replaces the subscription.
   */
  filter?: string;
  /**
   * When the subscription expires if idle. Omit for the 31-day default.
   */
  expirationPolicy?: SubscriptionExpirationPolicy;
  /**
   * Retry backoff after a NACK or ack-deadline exceed.
   */
  retryPolicy?: SubscriptionRetryPolicy;
  /**
   * Dead-letter topic and max delivery attempts. Omit to disable.
   *
   * Pub/Sub forwards dead letters as the project's Pub/Sub service agent
   * (`service-{projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`), so
   * reconcile grants it `roles/pubsub.publisher` on the dead-letter topic
   * and `roles/pubsub.subscriber` on this subscription. The topic grant is
   * left in place on delete: the agent is shared by every subscription in
   * the project that dead-letters to that topic.
   */
  deadLetterPolicy?: SubscriptionDeadLetterPolicy;
  /**
   * Push delivery endpoint. Omit (or leave empty) for a pull
   * subscription.
   */
  pushConfig?: SubscriptionPushConfig;
};

export type Subscription = Resource<
  "GCP.PubSub.Subscription",
  SubscriptionProps,
  {
    /** Full resource name `projects/{project}/subscriptions/{subscription}`. */
    name: string;
    /** Subscription id (last path segment). */
    subscriptionId: string;
    /** Project id. */
    project: string;
    /** Topic resource name this subscription is attached to. */
    topic: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Ack deadline in seconds. */
    ackDeadlineSeconds: number;
    /** Whether acknowledged messages are retained. */
    retainAckedMessages: boolean;
    /** Message retention duration, if set. */
    messageRetentionDuration: string | undefined;
    /** Whether message ordering is enabled. */
    enableMessageOrdering: boolean;
    /** Whether exactly-once delivery is enabled. */
    enableExactlyOnceDelivery: boolean;
    /** Filter expression, if set. */
    filter: string | undefined;
    /** Server-reported subscription state. */
    state: string | undefined;
    /** Idle expiration policy, if set. */
    expirationPolicy: SubscriptionExpirationPolicy | undefined;
    /** Retry policy, if set. */
    retryPolicy: SubscriptionRetryPolicy | undefined;
    /** Dead-letter policy, if set. */
    deadLetterPolicy: SubscriptionDeadLetterPolicy | undefined;
    /** Push config, if this is a push subscription. */
    pushConfig: SubscriptionPushConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Pub/Sub subscription.
 *
 * ### Creating a Subscription
 * **Example:** Pull subscription on a topic
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const subscription = yield* GCP.PubSub.Subscription("orders", {
 *   topic: topic.name,
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and ack deadline
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const subscription = yield* GCP.PubSub.Subscription("orders", {
 *   subscriptionId: "order-events",
 *   topic: topic.name,
 *   ackDeadlineSeconds: 30,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Pulling Messages
 * **Example:** Pull and acknowledge
 * ```typescript
 * const pull = yield* GCP.PubSub.Pull(subscription);
 * const { receivedMessages } = yield* pull({
 *   body: { maxMessages: 1 },
 * });
 * const ackIds = (receivedMessages ?? [])
 *   .map((message) => message.ackId)
 *   .filter((ackId): ackId is string => ackId !== undefined);
 * if (ackIds.length > 0) {
 *   const acknowledge = yield* GCP.PubSub.Acknowledge(subscription);
 *   yield* acknowledge({ body: { ackIds } });
 * }
 * ```
 *
 * @resource
 * @category PubSub
 */
export const Subscription = Resource<Subscription>("GCP.PubSub.Subscription");

export class SubscriptionNotResolved extends Data.TaggedError(
  "GCP.PubSub.SubscriptionNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_ACK_DEADLINE_SECONDS = 10;

const subscriptionIdOf = (name: string) => name.split("/").pop() ?? name;

const resourceName = (project: string, subscriptionId: string) =>
  `projects/${project}/subscriptions/${subscriptionId}`;

const topicNameOf = (project: string, topic: string) =>
  topic.startsWith("projects/") ? topic : `projects/${project}/topics/${topic}`;

const topicKey = (topic: string | undefined) =>
  topic === undefined ? undefined : subscriptionIdOf(topic);

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  subscriptionId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      subscriptionId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: 255,
        lowercase: true,
        forbiddenPrefixes: ["goog"],
      }))
    );
  });

const toPushConfig = (
  config: pubsub.PushConfig | undefined,
): SubscriptionPushConfig | undefined => {
  if (config === undefined) return undefined;
  const attributes = tagRecord(config.attributes);
  const pushEndpoint = config.pushEndpoint;
  if (pushEndpoint === undefined && Object.keys(attributes).length === 0) {
    return undefined;
  }
  return {
    pushEndpoint,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    oidcToken: config.oidcToken,
  };
};

const toAttrs = (subscription: pubsub.Subscription, project: string) => {
  const name = subscription.name ?? "";
  return {
    name,
    subscriptionId: subscriptionIdOf(name),
    project,
    topic: subscription.topic ?? "",
    labels: userLabels(subscription.labels),
    ackDeadlineSeconds:
      subscription.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS,
    retainAckedMessages: subscription.retainAckedMessages === true,
    messageRetentionDuration: subscription.messageRetentionDuration,
    enableMessageOrdering: subscription.enableMessageOrdering === true,
    enableExactlyOnceDelivery: subscription.enableExactlyOnceDelivery === true,
    filter: subscription.filter,
    state: subscription.state,
    expirationPolicy: subscription.expirationPolicy,
    retryPolicy: subscription.retryPolicy,
    deadLetterPolicy: subscription.deadLetterPolicy,
    pushConfig: toPushConfig(subscription.pushConfig),
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsSubscriptions({ subscription: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (existing) => existing === undefined,
      () => new SubscriptionStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.PubSub.SubscriptionStillExists",
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
    Effect.asVoid,
  );

export class SubscriptionStillExists extends Data.TaggedError(
  "GCP.PubSub.SubscriptionStillExists",
)<{ name: string }> {}

// Pub/Sub serves reads from replicas that lag writes: one successful GET
// does not mean the next one (or a publish routed to it) sees the
// resource. Require consecutive successful reads before reporting ready.
const CONSISTENT_READS = 3;

const waitUntilPresent = (name: string) =>
  Effect.gen(function* () {
    let found: pubsub.Subscription | undefined;
    for (let read = 0; read < CONSISTENT_READS; read++) {
      if (read > 0) yield* Effect.sleep("1 second");
      found = yield* getByName(name);
      if (found === undefined) {
        return yield* new SubscriptionNotResolved({ name });
      }
    }
    return found!;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.PubSub.SubscriptionNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 60,
    }),
  );

/**
 * Let the project's Pub/Sub service agent forward dead letters: publish to
 * the dead-letter topic and ack the original on the subscription.
 */
const grantDeadLetterAgent = (
  project: string,
  subscription: string,
  deadLetterTopic: string,
) =>
  Effect.gen(function* () {
    const number = yield* projectNumber(project);
    const member = `serviceAccount:service-${number}@gcp-sa-pubsub.iam.gserviceaccount.com`;
    yield* updateIamMembership({
      kind: "pubsub.topic",
      name: topicNameOf(project, deadLetterTopic),
      member,
      add: ["roles/pubsub.publisher"],
    });
    yield* updateIamMembership({
      kind: "pubsub.subscription",
      name: subscription,
      member,
      add: ["roles/pubsub.subscriber"],
    });
  });

const sameOptionalString = (
  left: string | undefined,
  right: string | undefined,
) => (left ?? "") === (right ?? "");

const retryChanged = (
  desired: SubscriptionRetryPolicy | undefined,
  observed: pubsub.RetryPolicy | undefined,
) =>
  desired !== undefined &&
  !(
    sameOptionalString(desired.minimumBackoff, observed?.minimumBackoff) &&
    sameOptionalString(desired.maximumBackoff, observed?.maximumBackoff)
  );

const deadLetterChanged = (
  desired: SubscriptionDeadLetterPolicy | undefined,
  observed: pubsub.DeadLetterPolicy | undefined,
) =>
  desired !== undefined &&
  !(
    sameOptionalString(desired.deadLetterTopic, observed?.deadLetterTopic) &&
    (desired.maxDeliveryAttempts ?? 0) === (observed?.maxDeliveryAttempts ?? 0)
  );

const expirationChanged = (
  desired: SubscriptionExpirationPolicy | undefined,
  observed: pubsub.ExpirationPolicy | undefined,
) => desired !== undefined && !sameOptionalString(desired.ttl, observed?.ttl);

const pushChanged = (
  desired: SubscriptionPushConfig | undefined,
  observed: pubsub.PushConfig | undefined,
) => {
  if (desired === undefined) return false;
  const observedAttributes = tagRecord(observed?.attributes);
  const desiredAttributes = tagRecord(desired.attributes);
  return (
    (desired.pushEndpoint ?? "") !== (observed?.pushEndpoint ?? "") ||
    JSON.stringify(desiredAttributes) !== JSON.stringify(observedAttributes) ||
    (desired.oidcToken?.serviceAccountEmail ?? "") !==
      (observed?.oidcToken?.serviceAccountEmail ?? "") ||
    (desired.oidcToken?.audience ?? "") !==
      (observed?.oidcToken?.audience ?? "")
  );
};

const toCreateBody = (
  topicName: string,
  news: SubscriptionProps,
  labels: Record<string, string>,
): pubsub.Subscription => {
  const body: pubsub.Subscription = {
    topic: topicName,
    labels,
  };
  if (news.ackDeadlineSeconds !== undefined) {
    body.ackDeadlineSeconds = news.ackDeadlineSeconds;
  }
  if (news.retainAckedMessages !== undefined) {
    body.retainAckedMessages = news.retainAckedMessages;
  }
  if (news.messageRetentionDuration !== undefined) {
    body.messageRetentionDuration = news.messageRetentionDuration;
  }
  if (news.enableMessageOrdering !== undefined) {
    body.enableMessageOrdering = news.enableMessageOrdering;
  }
  if (news.enableExactlyOnceDelivery !== undefined) {
    body.enableExactlyOnceDelivery = news.enableExactlyOnceDelivery;
  }
  if (news.filter !== undefined) {
    body.filter = news.filter;
  }
  if (news.expirationPolicy !== undefined) {
    body.expirationPolicy = news.expirationPolicy;
  }
  if (news.retryPolicy !== undefined) {
    body.retryPolicy = news.retryPolicy;
  }
  if (news.deadLetterPolicy !== undefined) {
    body.deadLetterPolicy = news.deadLetterPolicy;
  }
  if (news.pushConfig !== undefined) {
    body.pushConfig = news.pushConfig;
  }
  return body;
};

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: ["name", "subscriptionId", "project", "topic"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.subscriptionId ?? output?.subscriptionId;
      const nextId = news.subscriptionId ?? previousId;
      const nameChanged =
        news.subscriptionId !== undefined &&
        previousId !== undefined &&
        news.subscriptionId !== previousId;
      const previousTopic = olds?.topic ?? output?.topic;
      const topicChanged =
        previousTopic !== undefined &&
        topicKey(news.topic) !== topicKey(previousTopic);
      const previousFilter = olds?.filter ?? output?.filter ?? "";
      const nextFilter = news.filter ?? "";
      const previousOrdering =
        olds?.enableMessageOrdering ?? output?.enableMessageOrdering ?? false;
      const nextOrdering = news.enableMessageOrdering ?? false;
      if (
        !nameChanged &&
        !topicChanged &&
        previousFilter === nextFilter &&
        previousOrdering === nextOrdering
      ) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !nameChanged &&
          nextId !== undefined &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toId(
        id,
        olds?.subscriptionId,
        output?.subscriptionId,
      );
      const name = output?.name ?? resourceName(env.project, subscriptionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* pubsub.listProjectsSubscriptions
          .pages({
            project: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.subscriptions ?? []),
            ),
            Stream.filter((subscription) =>
              Object.keys(subscription.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((subscription) => toAttrs(subscription, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toId(
        id,
        news.subscriptionId,
        output?.subscriptionId,
      );
      const name = resourceName(env.project, subscriptionId);
      const topicName = topicNameOf(env.project, news.topic);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current =
        output !== undefined
          ? yield* waitUntilPresent(name).pipe(
              Effect.catchTag("GCP.PubSub.SubscriptionNotResolved", () =>
                Effect.succeed(undefined),
              ),
            )
          : yield* getByName(name);

      if (current === undefined) {
        const created = yield* pubsub
          .createProjectsSubscriptions({
            name,
            body: toCreateBody(topicName, news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => waitUntilPresent(name)));
        // Block until Pub/Sub serves the subscription: the create response
        // alone does not mean a GET (or a publish routed to it) sees it yet.
        current =
          created === undefined ? undefined : yield* waitUntilPresent(name);
      }

      if (current === undefined) {
        return yield* new SubscriptionNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const desiredAck =
        news.ackDeadlineSeconds ??
        current.ackDeadlineSeconds ??
        DEFAULT_ACK_DEADLINE_SECONDS;
      const ackChanged =
        desiredAck !==
        (current.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS);
      const desiredRetain =
        news.retainAckedMessages ?? current.retainAckedMessages ?? false;
      const retainChanged =
        desiredRetain !== (current.retainAckedMessages === true);
      const desiredExactlyOnce =
        news.enableExactlyOnceDelivery ??
        current.enableExactlyOnceDelivery ??
        false;
      const exactlyOnceChanged =
        desiredExactlyOnce !== (current.enableExactlyOnceDelivery === true);
      const retentionChanged =
        news.messageRetentionDuration !== undefined &&
        !sameOptionalString(
          news.messageRetentionDuration,
          current.messageRetentionDuration,
        );
      const expChanged = expirationChanged(
        news.expirationPolicy,
        current.expirationPolicy,
      );
      const retriesChanged = retryChanged(
        news.retryPolicy,
        current.retryPolicy,
      );
      const deadLettersChanged = deadLetterChanged(
        news.deadLetterPolicy,
        current.deadLetterPolicy,
      );
      const pushConfigChanged = pushChanged(
        news.pushConfig,
        current.pushConfig,
      );

      if (
        labelsChanged ||
        ackChanged ||
        retainChanged ||
        exactlyOnceChanged ||
        retentionChanged ||
        expChanged ||
        retriesChanged ||
        deadLettersChanged ||
        pushConfigChanged
      ) {
        current = yield* pubsub
          .patchProjectsSubscriptions({
            name,
            body: {
              subscription: {
                name,
                topic: topicName,
                labels: desiredLabels,
                ackDeadlineSeconds: desiredAck,
                retainAckedMessages: desiredRetain,
                enableExactlyOnceDelivery: desiredExactlyOnce,
                messageRetentionDuration:
                  news.messageRetentionDuration ??
                  current.messageRetentionDuration,
                expirationPolicy:
                  news.expirationPolicy ?? current.expirationPolicy,
                retryPolicy: news.retryPolicy ?? current.retryPolicy,
                deadLetterPolicy:
                  news.deadLetterPolicy ?? current.deadLetterPolicy,
                pushConfig: news.pushConfig ?? current.pushConfig,
              },
              updateMask: [
                labelsChanged ? "labels" : undefined,
                ackChanged ? "ackDeadlineSeconds" : undefined,
                retainChanged ? "retainAckedMessages" : undefined,
                exactlyOnceChanged ? "enableExactlyOnceDelivery" : undefined,
                retentionChanged ? "messageRetentionDuration" : undefined,
                expChanged ? "expirationPolicy" : undefined,
                retriesChanged ? "retryPolicy" : undefined,
                deadLettersChanged ? "deadLetterPolicy" : undefined,
                pushConfigChanged ? "pushConfig" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
          );
      }

      const deadLetterTopic = current.deadLetterPolicy?.deadLetterTopic;
      if (deadLetterTopic !== undefined && deadLetterTopic !== "") {
        yield* grantDeadLetterAgent(env.project, name, deadLetterTopic);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pubsub
        .deleteProjectsSubscriptions({ subscription: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Pub/Sub reads lag deletes; block until it stops serving it.
      yield* waitUntilGone(output.name);
    }),
  });
