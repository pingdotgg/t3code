import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  deleteHostServiceAccount,
  ensureHostServiceAccount,
  hostServiceAccountEmail,
  hostServiceAccountId,
  projectNumber,
} from "../Host.ts";
import {
  type GcpIamResourceKind,
  hasIamMembership,
  revokeIamMembership,
  updateIamMembership,
} from "../IamPolicy.ts";
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

export type SubscriptionBigQueryConfig = {
  /**
   * Table that receives the messages. Accepts a `GCP.BigQuery.Table`'s
   * `name` (`projects/{project}/datasets/{dataset}/tables/{table}`),
   * `{project}.{dataset}.{table}`, `{project}:{dataset}.{table}`, or
   * `{dataset}.{table}` in the deploying project.
   *
   * Pub/Sub writes as a service account Alchemy creates for this
   * subscription and grants `roles/bigquery.dataEditor` on the table.
   * The account and its grant are removed with the subscription.
   */
  table: string;
  /**
   * Write message fields to the table's columns using the topic's schema.
   * Cannot be combined with `useTableSchema`.
   * @default false
   */
  useTopicSchema?: boolean;
  /**
   * Write JSON message fields to the table's columns using the table's
   * schema. Cannot be combined with `useTopicSchema`.
   * @default false
   */
  useTableSchema?: boolean;
  /**
   * Also write `subscription_name`, `message_id`, `publish_time`, and
   * `attributes` to columns of the same names.
   * @default false
   */
  writeMetadata?: boolean;
  /**
   * With `useTopicSchema` or `useTableSchema`, drop message fields that
   * are not in the table schema instead of failing the write.
   * @default false
   */
  dropUnknownFields?: boolean;
  /**
   * Service account Pub/Sub writes to BigQuery as: an `IAM.ServiceAccount`'s
   * `email`, a referenced account's, or a literal email. Alchemy grants it
   * `roles/bigquery.dataEditor` on the table and lets the Pub/Sub service
   * agent act as it, then revokes only those grants when they are no
   * longer needed; the account and any roles it already held are left
   * alone. The deployer needs permission to edit the account's and the
   * table's IAM policies.
   *
   * Omit it and Alchemy creates an account for this subscription, deleted
   * with it.
   */
  serviceAccountEmail?: string;
};

/** One IAM grant a subscription made, revoked once it is no longer needed. */
export type SubscriptionIamGrant = {
  /** Kind of resource whose policy holds the grant. */
  kind: GcpIamResourceKind;
  /** Resource name of that resource. */
  name: string;
  /** Granted role. */
  role: string;
  /** Principal the role was granted to. */
  member: string;
};

export type SubscriptionBigQueryAttributes = {
  /** Destination table, as `{project}.{dataset}.{table}`. */
  table: string;
  /** Whether the topic's schema maps message fields to columns. */
  useTopicSchema: boolean;
  /** Whether the table's schema maps message fields to columns. */
  useTableSchema: boolean;
  /** Whether message metadata columns are written. */
  writeMetadata: boolean;
  /** Whether fields missing from the table schema are dropped. */
  dropUnknownFields: boolean;
  /** Service account Pub/Sub writes to BigQuery as. */
  serviceAccountEmail: string | undefined;
  /** Server-reported delivery state (`ACTIVE`, `PERMISSION_DENIED`, …). */
  state: string | undefined;
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
  /**
   * Write messages straight to a BigQuery table. Cannot be combined with
   * `pushConfig`.
   */
  bigqueryConfig?: SubscriptionBigQueryConfig;
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
    /** BigQuery delivery, if this is a BigQuery subscription. */
    bigqueryConfig: SubscriptionBigQueryAttributes | undefined;
    /** IAM grants this subscription made for its BigQuery writer. */
    iamGrants?: SubscriptionIamGrant[];
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
 * ### Writing to BigQuery
 * Pub/Sub writes each message as a row. Alchemy creates a service account
 * for the subscription and grants it write access to the table.
 *
 * **Example:** Write messages and their metadata to a table
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("impressions", {});
 * const dataset = yield* GCP.BigQuery.Dataset("raw", {});
 * const table = yield* GCP.BigQuery.Table("impression_event", {
 *   datasetId: dataset.datasetId,
 *   schema: [
 *     { name: "subscription_name", type: "STRING" },
 *     { name: "message_id", type: "STRING" },
 *     { name: "publish_time", type: "TIMESTAMP" },
 *     { name: "data", type: "STRING" },
 *     { name: "attributes", type: "STRING" },
 *   ],
 * });
 * const subscription = yield* GCP.PubSub.Subscription("impressions-bigquery", {
 *   topic: topic.name,
 *   bigqueryConfig: {
 *     table: table.name,
 *     writeMetadata: true,
 *   },
 * });
 * ```
 *
 * **Example:** Write as a service account you provide
 * ```typescript
 * const writer = yield* GCP.IAM.ServiceAccount("impressions-writer", {});
 * const subscription = yield* GCP.PubSub.Subscription("impressions-bigquery", {
 *   topic: topic.name,
 *   bigqueryConfig: {
 *     table: table.name,
 *     // also a referenced account's email, or a literal one
 *     serviceAccountEmail: writer.email,
 *   },
 * });
 * ```
 *
 * @resource
 * @category PubSub
 */
export const Subscription = Resource<Subscription>("GCP.PubSub.Subscription");

export class SubscriptionNotResolved extends Data.TaggedError(
  "GCP.PubSub.SubscriptionNotResolved",
)<{
  resourceName: string;
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

const toId = (id: string, subscriptionId: string | undefined, existing?: string) =>
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

const toBigQueryAttributes = (
  config: pubsub.BigQueryConfig | undefined,
): SubscriptionBigQueryAttributes | undefined => {
  if (config?.table === undefined || config.table === "") return undefined;
  return {
    table: config.table,
    useTopicSchema: config.useTopicSchema === true,
    useTableSchema: config.useTableSchema === true,
    writeMetadata: config.writeMetadata === true,
    dropUnknownFields: config.dropUnknownFields === true,
    serviceAccountEmail: config.serviceAccountEmail,
    state: config.state,
  };
};

type BigQueryTableRef = { project: string; datasetId: string; tableId: string };

/**
 * Parse every table form `bigqueryConfig.table` accepts. The project
 * group is greedy so domain-scoped ids (`example.com:proj`) keep their
 * dots; dataset ids never contain one.
 */
const parseBigQueryTable = (table: string, project: string): BigQueryTableRef | undefined => {
  const name = table.match(/^projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/);
  if (name) return { project: name[1]!, datasetId: name[2]!, tableId: name[3]! };
  const qualified = table.match(/^(.+)[.:](\w+)\.([^.]+)$/);
  if (qualified) {
    return { project: qualified[1]!, datasetId: qualified[2]!, tableId: qualified[3]! };
  }
  const local = table.match(/^(\w+)\.([^.]+)$/);
  if (local) return { project, datasetId: local[1]!, tableId: local[2]! };
  return undefined;
};

const bigqueryTableId = (table: BigQueryTableRef) =>
  `${table.project}.${table.datasetId}.${table.tableId}`;

const bigqueryTableName = (table: BigQueryTableRef) =>
  `projects/${table.project}/datasets/${table.datasetId}/tables/${table.tableId}`;

const BIGQUERY_WRITER_ROLE = "roles/bigquery.dataEditor";

export class SubscriptionInvalidBigQueryTable extends Data.TaggedError(
  "GCP.PubSub.SubscriptionInvalidBigQueryTable",
)<{ table: string }> {}

const toAttrs = (subscription: pubsub.Subscription, project: string) => {
  const name = subscription.name ?? "";
  return {
    name,
    subscriptionId: subscriptionIdOf(name),
    project,
    topic: subscription.topic ?? "",
    labels: userLabels(subscription.labels),
    ackDeadlineSeconds: subscription.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS,
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
    bigqueryConfig: toBigQueryAttributes(subscription.bigqueryConfig),
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsSubscriptions({ subscription: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (existing) => existing === undefined,
      () => new SubscriptionStillExists({ resourceName: name }),
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
)<{ resourceName: string }> {}

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
        return yield* new SubscriptionNotResolved({ resourceName: name });
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
const pubsubServiceAgent = (project: string) =>
  projectNumber(project).pipe(
    Effect.map(
      (number) => `serviceAccount:service-${number}@gcp-sa-pubsub.iam.gserviceaccount.com`,
    ),
  );

const grantDeadLetterAgent = (project: string, subscription: string, deadLetterTopic: string) =>
  Effect.gen(function* () {
    const member = yield* pubsubServiceAgent(project);
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

const sameOptionalString = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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
    (desired.oidcToken?.audience ?? "") !== (observed?.oidcToken?.audience ?? "")
  );
};

const sameFlag = (left: boolean | undefined, right: boolean | undefined) =>
  (left ?? false) === (right ?? false);

const bigqueryChanged = (
  desired: pubsub.BigQueryConfig | undefined,
  observed: pubsub.BigQueryConfig | undefined,
  project: string,
) => {
  const observedTable =
    observed?.table === undefined || observed.table === ""
      ? undefined
      : parseBigQueryTable(observed.table, project);
  if (desired === undefined) return observedTable !== undefined;
  return !(
    observedTable !== undefined &&
    bigqueryTableId(observedTable) === desired.table &&
    sameFlag(desired.useTopicSchema, observed?.useTopicSchema) &&
    sameFlag(desired.useTableSchema, observed?.useTableSchema) &&
    sameFlag(desired.writeMetadata, observed?.writeMetadata) &&
    sameFlag(desired.dropUnknownFields, observed?.dropUnknownFields) &&
    sameOptionalString(desired.serviceAccountEmail, observed?.serviceAccountEmail)
  );
};

const toCreateBody = (
  topicName: string,
  news: SubscriptionProps,
  labels: Record<string, string>,
  bigqueryConfig: pubsub.BigQueryConfig | undefined,
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
  if (bigqueryConfig !== undefined) {
    body.bigqueryConfig = bigqueryConfig;
  }
  return body;
};

const SUBSCRIPTION_TYPE = "GCP.PubSub.Subscription";

/**
 * The service account Alchemy mints for one subscription's BigQuery
 * writes. Keyed on the instance id, not just the name: IAM keeps serving a
 * deleted account's identity for minutes, so a destroy → redeploy that
 * re-created the same email would be rejected by Pub/Sub.
 */
const bigqueryWriterKey = (subscription: string, instanceId: string) =>
  `${subscription}#${instanceId}`;

const bigqueryWriterEmail = (project: string, subscription: string, instanceId: string) =>
  hostServiceAccountEmail(
    project,
    hostServiceAccountId(SUBSCRIPTION_TYPE, bigqueryWriterKey(subscription, instanceId)),
  );

const grantKey = (grant: SubscriptionIamGrant) =>
  `${grant.kind}\u0000${grant.name}\u0000${grant.role}\u0000${grant.member}`;

/**
 * Converge the BigQuery writer: mint the subscription's own account unless
 * one is given, grant it write access to the table, and let Pub/Sub's
 * service agent act as it. Returns the config Pub/Sub should run with and
 * the grants this subscription owns: everything for a minted account, and
 * for a given one only the grants it did not already hold.
 */
const ensureBigQueryWriter = Effect.fn(function* (options: {
  project: string;
  subscription: string;
  instanceId: string;
  config: SubscriptionBigQueryConfig;
  recorded: readonly SubscriptionIamGrant[];
}) {
  const { project, config } = options;
  const table = parseBigQueryTable(config.table, project);
  if (table === undefined) {
    return yield* new SubscriptionInvalidBigQueryTable({ table: config.table });
  }
  const given = config.serviceAccountEmail;
  const email =
    given ??
    (yield* ensureHostServiceAccount({
      project,
      hostType: SUBSCRIPTION_TYPE,
      resourceName: bigqueryWriterKey(options.subscription, options.instanceId),
      actAs: false,
    })).email;
  const desired: SubscriptionIamGrant[] = [
    {
      kind: "bigquery.table",
      name: bigqueryTableName(table),
      role: BIGQUERY_WRITER_ROLE,
      member: `serviceAccount:${email}`,
    },
    // Pub/Sub's service agent mints the account's tokens to write as it.
    {
      kind: "iam.serviceAccount",
      name: `projects/${given === undefined ? project : "-"}/serviceAccounts/${email}`,
      role: "roles/iam.serviceAccountTokenCreator",
      member: yield* pubsubServiceAgent(project),
    },
  ];
  const recorded = new Set(options.recorded.map(grantKey));
  const owned: SubscriptionIamGrant[] = [];
  for (const grant of desired) {
    // A given account may already hold the role for other reasons: use
    // it, but never record it, so it is never revoked.
    if (given !== undefined && !recorded.has(grantKey(grant)) && (yield* hasIamMembership(grant))) {
      continue;
    }
    yield* updateIamMembership({ ...grant, add: [grant.role] });
    owned.push(grant);
  }
  return {
    grants: owned,
    config: {
      table: bigqueryTableId(table),
      useTopicSchema: config.useTopicSchema ?? false,
      useTableSchema: config.useTableSchema ?? false,
      writeMetadata: config.writeMetadata ?? false,
      dropUnknownFields: config.dropUnknownFields ?? false,
      serviceAccountEmail: email,
    } satisfies pubsub.BigQueryConfig,
  };
});

/** Revoke recorded grants that `keep` no longer contains. */
const revokeStaleGrants = Effect.fn(function* (
  recorded: readonly SubscriptionIamGrant[],
  keep: readonly SubscriptionIamGrant[],
) {
  const kept = new Set(keep.map(grantKey));
  for (const grant of recorded) {
    if (kept.has(grantKey(grant))) continue;
    yield* revokeIamMembership({ ...grant, roles: [grant.role] });
  }
});

/**
 * Pub/Sub rejects a just-minted writer (`BigQueryServiceAccountNotReady`)
 * and fresh grants on it (`Forbidden`) until IAM propagates them.
 */
const retryWriterGrants =
  (bigqueryConfig: pubsub.BigQueryConfig | undefined) =>
  <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    bigqueryConfig === undefined
      ? effect
      : effect.pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "BigQueryServiceAccountNotReady" || error._tag === "Forbidden",
            times: 10,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );

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
        previousTopic !== undefined && topicKey(news.topic) !== topicKey(previousTopic);
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
          !nameChanged && nextId !== undefined && previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toId(id, olds?.subscriptionId, output?.subscriptionId);
      const name = output?.name ?? resourceName(env.project, subscriptionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = { ...toAttrs(existing, env.project), iamGrants: output?.iamGrants };
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
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
            Stream.flatMap((page) => Stream.fromIterable(page.subscriptions ?? [])),
            Stream.filter((subscription) =>
              Object.keys(subscription.labels ?? {}).some((key) => key.startsWith("alchemy-")),
            ),
            Stream.map((subscription) => toAttrs(subscription, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const env = yield* GcpEnvironment.current;
      const subscriptionId = yield* toId(id, news.subscriptionId, output?.subscriptionId);
      const name = resourceName(env.project, subscriptionId);
      const topicName = topicNameOf(env.project, news.topic);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const previousGrants = output?.iamGrants ?? [];
      const writer =
        news.bigqueryConfig === undefined
          ? undefined
          : yield* ensureBigQueryWriter({
              project: env.project,
              subscription: name,
              instanceId,
              config: news.bigqueryConfig,
              recorded: previousGrants,
            });
      const bigqueryConfig = writer?.config;

      let current =
        output !== undefined
          ? yield* waitUntilPresent(name).pipe(
              Effect.catchTag("GCP.PubSub.SubscriptionNotResolved", () => Effect.undefined),
            )
          : yield* getByName(name);

      if (current === undefined) {
        const created = yield* pubsub
          .createProjectsSubscriptions({
            name,
            body: toCreateBody(topicName, news, desiredLabels, bigqueryConfig),
          })
          .pipe(
            retryWriterGrants(bigqueryConfig),
            Effect.catchTag("Conflict", () => waitUntilPresent(name)),
          );
        // Block until Pub/Sub serves the subscription: the create response
        // alone does not mean a GET (or a publish routed to it) sees it yet.
        current = created === undefined ? undefined : yield* waitUntilPresent(name);
      }

      if (current === undefined) {
        return yield* new SubscriptionNotResolved({ resourceName: name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const desiredAck =
        news.ackDeadlineSeconds ?? current.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS;
      const ackChanged =
        desiredAck !== (current.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS);
      const desiredRetain = news.retainAckedMessages ?? current.retainAckedMessages ?? false;
      const retainChanged = desiredRetain !== (current.retainAckedMessages === true);
      const desiredExactlyOnce =
        news.enableExactlyOnceDelivery ?? current.enableExactlyOnceDelivery ?? false;
      const exactlyOnceChanged =
        desiredExactlyOnce !== (current.enableExactlyOnceDelivery === true);
      const retentionChanged =
        news.messageRetentionDuration !== undefined &&
        !sameOptionalString(news.messageRetentionDuration, current.messageRetentionDuration);
      const expChanged = expirationChanged(news.expirationPolicy, current.expirationPolicy);
      const retriesChanged = retryChanged(news.retryPolicy, current.retryPolicy);
      const deadLettersChanged = deadLetterChanged(news.deadLetterPolicy, current.deadLetterPolicy);
      const pushConfigChanged = pushChanged(news.pushConfig, current.pushConfig);
      const bigqueryConfigChanged = bigqueryChanged(
        bigqueryConfig,
        current.bigqueryConfig,
        env.project,
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
        pushConfigChanged ||
        bigqueryConfigChanged
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
                  news.messageRetentionDuration ?? current.messageRetentionDuration,
                expirationPolicy: news.expirationPolicy ?? current.expirationPolicy,
                retryPolicy: news.retryPolicy ?? current.retryPolicy,
                deadLetterPolicy: news.deadLetterPolicy ?? current.deadLetterPolicy,
                pushConfig: news.pushConfig ?? current.pushConfig,
                // Masked but omitted clears it: back to a pull subscription.
                bigqueryConfig,
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
                bigqueryConfigChanged ? "bigqueryConfig" : undefined,
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
            retryWriterGrants(bigqueryConfig),
          );
      }

      // Only after Pub/Sub switched over: revoke what the previous writer
      // or table no longer needs. A minted writer itself lives until the
      // subscription is deleted, so turning BigQuery back on reuses it.
      yield* revokeStaleGrants(previousGrants, writer?.grants ?? []);

      const deadLetterTopic = current.deadLetterPolicy?.deadLetterTopic;
      if (deadLetterTopic !== undefined && deadLetterTopic !== "") {
        yield* grantDeadLetterAgent(env.project, name, deadLetterTopic);
      }

      return { ...toAttrs(current, env.project), iamGrants: writer?.grants ?? [] };
    }),

    delete: Effect.fn(function* ({ instanceId, output }) {
      yield* pubsub
        .deleteProjectsSubscriptions({ subscription: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Pub/Sub reads lag deletes; block until it stops serving it.
      yield* waitUntilGone(output.name);
      // Then revoke the grants it made, and drop the writer Alchemy minted
      // for it. Look the writer up even without recorded grants: a create
      // that failed after minting it never recorded any.
      yield* revokeStaleGrants(output.iamGrants ?? [], []);
      const writer = bigqueryWriterEmail(output.project, output.name, instanceId);
      const minted = yield* iam
        .getProjectsServiceAccounts({
          name: `projects/${output.project}/serviceAccounts/${writer}`,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
      if (minted) {
        yield* deleteHostServiceAccount({ project: output.project, email: writer });
      }
    }),
  });
