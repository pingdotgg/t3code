import * as sqs from "@distilled.cloud/aws/sqs";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AdoptPolicy, OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { isResolved } from "../../Diff.ts";
import { isOutput } from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type QueueName = string;
export type QueueArn = `arn:aws:sqs:${RegionID}:${AccountID}:${QueueName}`;
export type QueueUrl = string;

export type QueueProps = {
  /**
   * Name of the queue. Must be a literal value, available before precreation.
   * The reserved `.fifo` suffix is added for FIFO queues and removed for standard queues.
   * @default ${app}-${stage}-${id}?.fifo
   */
  queueName?: string;
  /**
   * Delay applied to all messages in the queue (`0` - `900` seconds).
   * Accepts any `Duration.Input` (e.g. `"30 seconds"`,
   * `Duration.seconds(30)`; a bare number is milliseconds); the wire unit
   * is whole seconds.
   * @default 0
   */
  delay?: Duration.Input;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * How long messages are retained (`60` - `1,209,600` seconds). Accepts
   * any `Duration.Input` (e.g. `"4 days"`, `Duration.days(4)`; a bare
   * number is milliseconds); the wire unit is whole seconds.
   * @default 4 days
   */
  messageRetentionPeriod?: Duration.Input;
  /**
   * How long `ReceiveMessage` waits for a message (`0` - `20` seconds).
   * Accepts any `Duration.Input` (e.g. `"20 seconds"`,
   * `Duration.seconds(20)`; a bare number is milliseconds); the wire unit
   * is whole seconds.
   * @default 0
   */
  receiveMessageWaitTime?: Duration.Input;
  /**
   * Visibility timeout (`0` - `43,200` seconds). Accepts any
   * `Duration.Input` (e.g. `"30 seconds"`, `Duration.seconds(30)`; a bare
   * number is milliseconds); the wire unit is whole seconds.
   * @default 30 seconds
   */
  visibilityTimeout?: Duration.Input;
  /**
   * Dead-letter queue redrive policy. Failed messages are moved to the
   * dead-letter queue after `maxReceiveCount` receive attempts. The
   * dead-letter queue must be the same type (a FIFO source requires a
   * FIFO dead-letter queue).
   */
  redrivePolicy?: {
    /**
     * The ARN of the dead-letter queue that failed messages are moved to.
     */
    deadLetterTargetArn: string;
    /**
     * The number of times a message is received before it is moved to the
     * dead-letter queue (`1` - `1000`).
     */
    maxReceiveCount: number;
  };
  /**
   * Redrive-allow policy. Set on the **dead-letter queue** to authorize
   * which source queues may use it.
   */
  redriveAllowPolicy?: {
    /**
     * Whether all, none, or a specified list of source queues may use this
     * queue as a dead-letter queue.
     */
    redrivePermission: "allowAll" | "denyAll" | "byQueue";
    /**
     * The ARNs of the source queues permitted to use this dead-letter
     * queue. Only valid (and required) when `redrivePermission` is
     * `byQueue` (up to 10 ARNs).
     */
    sourceQueueArns?: string[];
  };
  /**
   * An access-control policy document (IAM policy JSON) attached to the
   * queue. Provided as a JSON string or a plain object. Merged with any
   * policy statements contributed by capability bindings.
   */
  policy?: string | Record<string, any>;
  /**
   * The ID, alias, or ARN of a KMS key for server-side encryption (SSE-KMS).
   * Use `alias/aws/sqs` for the AWS-managed SQS key. Mutually exclusive with
   * `sqsManagedSseEnabled`.
   */
  kmsMasterKeyId?: string;
  /**
   * How long SQS reuses a data key before calling KMS again (`60` -
   * `86,400` seconds). Accepts any `Duration.Input` (e.g. `"5 minutes"`,
   * `Duration.minutes(5)`; a bare number is milliseconds); the wire unit
   * is whole seconds. Only meaningful with `kmsMasterKeyId`.
   * @default 5 minutes
   */
  kmsDataKeyReusePeriod?: Duration.Input;
  /**
   * Enables server-side encryption using SQS-owned keys (SSE-SQS).
   * Mutually exclusive with `kmsMasterKeyId`.
   * @default false
   */
  sqsManagedSseEnabled?: boolean;
  /**
   * Tags to apply to the queue. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
} & (
  | {
      /** Standard queue mode. Must be known before precreation. */
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
      /** FIFO queue mode. Must be known before precreation. */
      fifo: true;
      /**
       * Enables content-based deduplication for FIFO queues. Only valid when `fifo` is `true`.
       * @default false
       */
      contentBasedDeduplication?: boolean;
      /**
       * Specifies whether message deduplication occurs at the message group or queue level.
       * Valid values are `messageGroup` and `queue`. Only valid when `fifo` is `true`.
       */
      deduplicationScope?: "messageGroup" | "queue";
      /**
       * Specifies whether the FIFO queue throughput quota applies to the entire queue or per message group.
       * Valid values are `perQueue` and `perMessageGroupId`. Only valid when `fifo` is `true`.
       */
      fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
    }
);

export interface Queue extends Resource<
  "AWS.SQS.Queue",
  QueueProps,
  {
    queueUrl: string;
    queueName: QueueName;
    queueArn: QueueArn;
  },
  {
    policyStatements: PolicyStatement[];
  },
  Providers
> {}

class QueueStillExists extends Data.TaggedError("QueueStillExists")<{
  readonly queueUrl: string;
}> {}

/**
 * An Amazon SQS queue for reliable, decoupled message processing.
 *
 * `Queue` owns the lifecycle of a standard or FIFO SQS queue. A queue name
 * is auto-generated from the app, stage, and logical ID unless you provide
 * one explicitly. The `.fifo` suffix follows the `fifo` setting, including
 * for explicit names. Changing queue mode replaces the physical queue and
 * updates downstream references; existing messages are not migrated.
 *
 * `queueName` and `fifo` must be known before the queue is precreated; unresolved
 * resource outputs in these identity properties fail with `UnresolvedQueueIdentity`.
 * Mutable settings and policy bindings may reference other resource outputs,
 * including the queue's own ARN.
 *
 * ### Creating Queues
 * **Example:** Standard Queue
 * ```typescript
 * import * as SQS from "alchemy/AWS/SQS";
 *
 * const queue = yield* SQS.Queue("OrdersQueue");
 * ```
 *
 * **Example:** FIFO Queue
 * ```typescript
 * const queue = yield* SQS.Queue("OrdersFifoQueue", {
 *   fifo: true,
 *   contentBasedDeduplication: true,
 * });
 * ```
 *
 * **Example:** Queue with Custom Settings
 * ```typescript
 * const queue = yield* SQS.Queue("ProcessingQueue", {
 *   visibilityTimeout: "2 minutes",
 *   messageRetentionPeriod: "1 day",
 *   receiveMessageWaitTime: "20 seconds",
 * });
 * ```
 *
 * ### Adopting an Existing Queue
 * **Example:** Adopt a queue with output-valued settings
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as SQS from "alchemy/AWS/SQS";
 *
 * const audit = yield* SQS.Queue("Audit");
 * const orders = yield* SQS.Queue("Orders", {
 *   queueName: "existing-orders",
 *   tags: { auditQueue: audit.queueArn },
 * }).pipe(Alchemy.adopt(true));
 * ```
 * Explicit adoption preserves the queue identity and messages while reconciling
 * settings, policies, and tags, even when mutable properties depend on other resources.
 *
 * ### Dead-Letter Queues
 * **Example:** Route failures to a dead-letter queue
 * ```typescript
 * const dlq = yield* SQS.Queue("OrdersDLQ");
 * const orders = yield* SQS.Queue("Orders", {
 *   redrivePolicy: {
 *     deadLetterTargetArn: dlq.queueArn,
 *     maxReceiveCount: 3,
 *   },
 * });
 * ```
 *
 * **Example:** Authorize source queues on the dead-letter queue
 * ```typescript
 * const dlq = yield* SQS.Queue("OrdersDLQ", {
 *   redriveAllowPolicy: {
 *     redrivePermission: "byQueue",
 *     sourceQueueArns: [orders.queueArn],
 *   },
 * });
 * ```
 *
 * ### Encryption
 * **Example:** SSE-SQS (SQS-managed keys)
 * ```typescript
 * const queue = yield* SQS.Queue("SecureQueue", {
 *   sqsManagedSseEnabled: true,
 * });
 * ```
 *
 * **Example:** SSE-KMS (AWS-managed key)
 * ```typescript
 * const queue = yield* SQS.Queue("KmsQueue", {
 *   kmsMasterKeyId: "alias/aws/sqs",
 *   kmsDataKeyReusePeriod: "5 minutes",
 * });
 * ```
 *
 * ### Sending Messages
 * Bind send operations in the init phase and use them in runtime
 * handlers.
 *
 * **Example:** Send a message from a handler
 * ```typescript
 * // init
 * const sendMessage = yield* SQS.SendMessage(queue);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* sendMessage({
 *       MessageBody: JSON.stringify({ orderId: "123" }),
 *     });
 *     return HttpServerResponse.text("Queued");
 *   }),
 * };
 * ```
 *
 * ### Event Sources
 * Process messages from a queue using a Lambda event source mapping.
 * Messages are automatically deleted after successful processing.
 *
 * **Example:** Process queue messages
 * ```typescript
 * // init
 * yield* SQS.consumeQueueMessages(queue,
 *   Effect.fn(function* (message) {
 *     yield* Effect.log(`Received: ${message.body}`);
 *   }),
 * );
 * ```
 *
 * @resource
 */
export const Queue = Resource<Queue>("AWS.SQS.Queue");

/**
 * Raised when a `Queue` is configured with both `kmsMasterKeyId` (SSE-KMS)
 * and `sqsManagedSseEnabled` (SSE-SQS). The two encryption modes are
 * mutually exclusive.
 */
export class SqsEncryptionConflict extends Data.TaggedError(
  "SqsEncryptionConflict",
)<{ message: string }> {}

/** Raised when a queue identity depends on an unresolved resource output. */
export class UnresolvedQueueIdentity extends Data.TaggedError(
  "UnresolvedQueueIdentity",
)<{ message: string }> {}

const validateEncryption = (props: QueueProps) =>
  props.kmsMasterKeyId !== undefined && props.sqsManagedSseEnabled
    ? Effect.fail(
        new SqsEncryptionConflict({
          message:
            "kmsMasterKeyId (SSE-KMS) and sqsManagedSseEnabled (SSE-SQS) are mutually exclusive — set only one.",
        }),
      )
    : Effect.void;

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const createQueueName = Effect.fn(function* (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) {
        if (props.queueName) {
          const baseName = props.queueName.endsWith(".fifo")
            ? props.queueName.slice(0, -".fifo".length)
            : props.queueName;
          return props.fifo ? `${baseName}.fifo` : baseName;
        }
        const baseName = yield* createPhysicalName({
          id,
          maxLength: props.fifo ? 80 - ".fifo".length : 80,
        });
        return props.fifo ? `${baseName}.fifo` : baseName;
      });
      const buildPolicy = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ): string | undefined => {
        const bindingStatements = bindings.flatMap(
          (p) => p.data.policyStatements,
        );
        let userStatements: any[] = [];
        if (props.policy !== undefined) {
          const doc =
            typeof props.policy === "string"
              ? JSON.parse(props.policy)
              : props.policy;
          const stmt = doc?.Statement;
          userStatements = Array.isArray(stmt) ? stmt : stmt ? [stmt] : [];
        }
        const statements = [...userStatements, ...bindingStatements];
        if (statements.length === 0) return undefined;
        return JSON.stringify({
          Version: "2012-10-17",
          Statement: statements,
        });
      };
      // Build the desired attribute map. Keys present here are reconciled
      // against observed cloud state. An empty-string value explicitly
      // CLEARS an attribute (SQS interprets `""` as "remove"); `undefined`
      // means "leave alone" and is filtered out before diffing.
      const createAttributes = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ) => {
        // Removable attributes always emit a key: the desired value when set,
        // or "" to clear when the prop is absent. This lets the delta loop
        // converge when a user removes redrive/policy/kms props.
        const redrivePolicy = props.redrivePolicy
          ? JSON.stringify({
              deadLetterTargetArn: props.redrivePolicy.deadLetterTargetArn,
              maxReceiveCount: props.redrivePolicy.maxReceiveCount,
            })
          : "";
        const redriveAllowPolicy = props.redriveAllowPolicy
          ? JSON.stringify({
              redrivePermission: props.redriveAllowPolicy.redrivePermission,
              ...(props.redriveAllowPolicy.sourceQueueArns
                ? { sourceQueueArns: props.redriveAllowPolicy.sourceQueueArns }
                : {}),
            })
          : "";
        const policy = buildPolicy(props, bindings) ?? "";

        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: toWireSeconds(props.delay)?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: toWireSeconds(
            props.messageRetentionPeriod,
          )?.toString(),
          ReceiveMessageWaitTimeSeconds: toWireSeconds(
            props.receiveMessageWaitTime,
          )?.toString(),
          VisibilityTimeout: toWireSeconds(props.visibilityTimeout)?.toString(),
          RedrivePolicy: redrivePolicy,
          RedriveAllowPolicy: redriveAllowPolicy,
          Policy: policy,
          KmsMasterKeyId: props.kmsMasterKeyId,
          KmsDataKeyReusePeriodSeconds: toWireSeconds(
            props.kmsDataKeyReusePeriod,
          )?.toString(),
          SqsManagedSseEnabled:
            props.sqsManagedSseEnabled === undefined
              ? undefined
              : props.sqsManagedSseEnabled
                ? "true"
                : "false",
        };

        if (props.fifo) {
          return {
            ...baseAttributes,
            FifoQueue: "true",
            FifoThroughputLimit: props.fifoThroughputLimit,
            ContentBasedDeduplication: props.contentBasedDeduplication
              ? "true"
              : "false",
            DeduplicationScope: props.deduplicationScope,
          };
        }

        return baseAttributes;
      };
      const ensureQueueExists = Effect.fn(function* ({
        id,
        news = {},
        output,
        bindings = [],
      }: {
        id: string;
        news: QueueProps;
        output?: Queue["Attributes"];
        bindings?: ResourceBinding<Queue["Binding"]>[];
      }) {
        yield* validateEncryption(news);
        const { accountId, region } = yield* AWSEnvironment.current;
        const queueName =
          output?.queueName ?? (yield* createQueueName(id, news));
        const queueArn =
          `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
        let queueUrl = yield* sqs.getQueueUrl({ QueueName: queueName }).pipe(
          Effect.map((r) => r.QueueUrl),
          Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(undefined)),
        );

        if (queueUrl === undefined) {
          const internalTags = yield* createInternalTags(id);
          const attributes: Record<string, string> = {};
          // Empty strings clear existing attributes but are invalid on create.
          for (const [key, value] of Object.entries(
            createAttributes(news, bindings),
          )) {
            if (value !== undefined && value !== "") attributes[key] = value;
          }
          queueUrl = yield* sqs
            .createQueue({
              QueueName: queueName,
              Attributes: attributes,
              tags: { ...news.tags, ...internalTags },
            })
            .pipe(
              Effect.catchTag("QueueNameExists", () =>
                sqs.getQueueUrl({ QueueName: queueName }),
              ),
              Effect.retry({
                while: (error) =>
                  error._tag === "QueueDeletedRecently" ||
                  error._tag === "QueueDoesNotExist" ||
                  (news.redrivePolicy !== undefined &&
                    error._tag === "InvalidParameterValueException" &&
                    error.message?.includes(
                      "Dead letter target does not exist",
                    ) === true),
                // Allow propagation beyond SQS's 60-second name reuse cooldown.
                schedule: Schedule.spaced("7 seconds"),
                times: 10,
              }),
              Effect.map((r) => r.QueueUrl!),
            );
        }

        return { queueName, queueUrl, queueArn };
      });
      return Queue.Provider.of({
        stables: ["queueName", "queueUrl", "queueArn"],
        // Enumerate every queue in the ambient account/region. `listQueues`
        // returns queue URLs (paginated), which we hydrate into the exact `read`
        // shape. A queue can vanish between enumeration and hydration, so we
        // tolerate the typed `QueueDoesNotExist` per item and drop it.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const urls = yield* sqs.listQueues.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.QueueUrls ?? []),
              ),
            );
            const items = yield* Effect.forEach(
              urls,
              (queueUrl) =>
                sqs
                  .getQueueAttributes({
                    QueueUrl: queueUrl,
                    AttributeNames: ["QueueArn"],
                  })
                  .pipe(
                    Effect.map((r) => {
                      const queueName =
                        r.Attributes?.QueueArn?.split(":").pop() ??
                        queueUrl.split("/").pop()!;
                      const queueArn =
                        `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
                      return { queueName, queueUrl, queueArn };
                    }),
                    Effect.catchTag("QueueDoesNotExist", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is Queue["Attributes"] => item !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const queueName =
            output?.queueName ?? (yield* createQueueName(id, olds ?? {}));
          const url = yield* sqs.getQueueUrl({ QueueName: queueName }).pipe(
            Effect.map((r) => r.QueueUrl),
            Effect.catchTag("QueueDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!url) return undefined;
          const queueArn =
            `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
          const tagsResp = yield* sqs.listQueueTags({ QueueUrl: url }).pipe(
            Effect.map((r) => r.Tags ?? {}),
            Effect.catchTag("QueueDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );
          if (tagsResp === undefined) return undefined;
          const attrs = {
            queueName,
            queueUrl: url,
            queueArn,
          };
          return (yield* hasAlchemyTags(id, tagsResp)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {}, output }) {
          if (isOutput(news) || Effect.isEffect(news) || Config.isConfig(news))
            return undefined;
          const identity = { queueName: news.queueName, fifo: news.fifo };
          if (!isResolved<Pick<QueueProps, "queueName" | "fifo">>(identity))
            return undefined;
          const encryption = {
            kmsMasterKeyId: news.kmsMasterKeyId,
            sqsManagedSseEnabled: news.sqsManagedSseEnabled,
          };
          if (
            isResolved<
              Pick<QueueProps, "kmsMasterKeyId" | "sqsManagedSseEnabled">
            >(encryption)
          )
            yield* validateEncryption(encryption);
          const oldFifo = olds.fifo ?? false;
          const newFifo = identity.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName =
            output?.queueName ?? (yield* createQueueName(id, olds));
          const newQueueName = yield* createQueueName(id, identity);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        // Mutable properties and bindings may reference identities that do not exist yet.
        precreate: Effect.fn(function* ({ id, fqn, news = {} }) {
          const identity = { queueName: news.queueName, fifo: news.fifo };
          if (!isResolved(identity)) {
            return yield* Effect.fail(
              new UnresolvedQueueIdentity({
                message:
                  "Queue queueName and fifo must be known before precreation; use literal identity properties and put circular references in bindings.",
              }),
            );
          }
          if (
            isResolved({
              kmsMasterKeyId: news.kmsMasterKeyId,
              sqsManagedSseEnabled: news.sqsManagedSseEnabled,
            })
          ) {
            yield* validateEncryption(news);
          }
          const output = yield* ensureQueueExists({ id, news: identity });
          // Unresolved mutable props can defer the engine's ownership probe.
          const tags = yield* sqs
            .listQueueTags({ QueueUrl: output.queueUrl })
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "QueueDoesNotExist",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
            );
          if (!(yield* hasAlchemyTags(id, tags.Tags ?? {}))) {
            const stack = yield* Stack;
            const adopt =
              stack.resources[fqn]?.Adopt ??
              Option.getOrUndefined(yield* Effect.serviceOption(AdoptPolicy)) ??
              (yield* AlchemyContext).adopt;
            if (!adopt) {
              return yield* new OwnedBySomeoneElse({
                message: `Cannot adopt SQS queue '${output.queueName}' without explicit adoption.`,
                resourceType: Queue.Type,
                logicalId: id,
                physicalName: output.queueName,
              });
            }
          }
          return output;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          output,
          session,
          bindings,
        }) {
          const { queueName, queueUrl, queueArn } = yield* ensureQueueExists({
            id,
            news,
            output,
            bindings,
          });
          const desiredAttributes = createAttributes(news, bindings);
          const internalTags = yield* createInternalTags(id);

          // Sync attributes — diff observed cloud state against desired and
          // apply only the delta. SQS returns all attribute values as strings,
          // and `desiredAttributes` is already string-shaped, so equality
          // comparison is direct.
          // SQS is eventually consistent: a freshly-created queue can return
          // `QueueDoesNotExist` from `getQueueAttributes` for a few seconds
          // even after `createQueue` succeeded. Retry briefly so the
          // reconciler converges instead of failing the first deploy.
          const currentAttributes = yield* sqs
            .getQueueAttributes({
              QueueUrl: queueUrl,
              AttributeNames: ["All"],
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
              Effect.map((r) => r.Attributes ?? {}),
            );

          const attributeDelta: Record<string, string> = {};
          for (const [key, value] of Object.entries(desiredAttributes)) {
            // FifoQueue is immutable and only valid on CreateQueue.
            if (value === undefined || key === "FifoQueue") continue;
            const current =
              currentAttributes[key as keyof typeof currentAttributes];
            // Desired-to-clear ("") only needs an API call when the attribute
            // is actually present; SQS rejects clearing an already-absent attr.
            if (value === "" && (current === undefined || current === "")) {
              continue;
            }
            if (current !== value) {
              attributeDelta[key] = value;
            }
          }
          if (Object.keys(attributeDelta).length > 0) {
            yield* sqs
              .setQueueAttributes({
                QueueUrl: queueUrl,
                Attributes: attributeDelta,
              })
              .pipe(
                Effect.retry({
                  while: (e) =>
                    e._tag === "QueueDoesNotExist" ||
                    (attributeDelta.RedrivePolicy !== undefined &&
                      e._tag === "InvalidParameterValueException" &&
                      e.message?.includes(
                        "Dead letter target does not exist",
                      ) === true),
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
          }

          // Sync alchemy-owned tags. The `tags` parameter on `createQueue`
          // only applies on first create, so on adoption (or after a queue
          // was created without our tags) we fix them up here.
          const observedTags = yield* sqs
            .listQueueTags({ QueueUrl: queueUrl })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
              Effect.map((r) => r.Tags ?? {}),
            );
          // Merge user tags with internal Alchemy tags and diff against the
          // OBSERVED cloud tags (not olds) so adoption converges. User tags
          // can be removed, so we untag removed keys; internal tags are never
          // user-removable so they survive.
          const desiredTags: Record<string, string> = {
            ...(news.tags ?? {}),
            ...internalTags,
          };
          const currentTags: Record<string, string> = {};
          for (const [key, value] of Object.entries(observedTags)) {
            if (value !== undefined) currentTags[key] = value;
          }
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* sqs
              .tagQueue({
                QueueUrl: queueUrl,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
          }
          if (removed.length > 0) {
            yield* sqs
              .untagQueue({ QueueUrl: queueUrl, TagKeys: removed })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
          }

          yield* session.note(queueUrl);
          return {
            queueName,
            queueUrl,
            queueArn,
          };
        }),
        delete: Effect.fn(function* (input) {
          const queueUrl = input.output.queueUrl;
          yield* sqs
            .deleteQueue({
              QueueUrl: queueUrl,
            })
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "RequestThrottled",
                schedule: Schedule.exponential("500 millis"),
                times: 6,
              }),
              Effect.catchTag("QueueDoesNotExist", () => Effect.void),
            );

          // DeleteQueue is asynchronous and SQS can keep serving the queue
          // for up to 60 seconds. GetQueueAttributes can report not-found
          // before ListQueues stops returning the URL, and nuke discovers
          // queues through ListQueues. Require both control-plane views to
          // agree before state is removed or a same-name replacement starts.
          // Typed read throttles mean "absence not confirmed yet" and retry;
          // re-entering delete remains safe because QueueDoesNotExist is OK.
          const queueName = queueUrl.slice(queueUrl.lastIndexOf("/") + 1);
          yield* Effect.gen(function* () {
            const attributesAbsent = yield* sqs
              .getQueueAttributes({
                QueueUrl: queueUrl,
                AttributeNames: ["QueueArn"],
              })
              .pipe(
                Effect.as(false),
                Effect.catchTag("QueueDoesNotExist", () =>
                  Effect.succeed(true),
                ),
                Effect.catchTag("RequestThrottled", () =>
                  Effect.succeed(false),
                ),
              );
            const absentFromList = yield* sqs
              .listQueues({ QueueNamePrefix: queueName })
              .pipe(
                Effect.map(
                  (result) => !(result.QueueUrls ?? []).includes(queueUrl),
                ),
                Effect.catchTag("RequestThrottled", () =>
                  Effect.succeed(false),
                ),
              );
            if (!attributesAbsent || !absentFromList) {
              return yield* Effect.fail(new QueueStillExists({ queueUrl }));
            }
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "QueueStillExists",
              schedule: Schedule.spaced("6 seconds"),
              times: 10,
            }),
          );
        }),
      });
    }),
  );
