import { Region } from "@distilled.cloud/aws/Region";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type QueueName = string;
export type QueueArn = `arn:aws:sqs:${RegionID}:${AccountID}:${QueueName}`;
export type QueueUrl = string;

export type QueueProps = {
  /**
   * Name of the queue.
   * @default ${app}-${stage}-${id}?.fifo
   */
  queueName?: string;
  /**
   * Delay in seconds for all messages in the queue (`0` - `900`).
   * @default 0
   */
  delaySeconds?: number;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * Message retention period in seconds (`60` - `1,209,600`).
   * @default 345600
   */
  messageRetentionPeriod?: number;
  /**
   * Time in seconds for `ReceiveMessage` to wait for a message (`0` - `20`).
   * @default 0
   */
  receiveMessageWaitTimeSeconds?: number;
  /**
   * Visibility timeout in seconds (`0` - `43,200`).
   * @default 30
   */
  visibilityTimeout?: number;
} & (
  | {
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
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

/**
 * An Amazon SQS queue for reliable, decoupled message processing.
 *
 * `Queue` owns the lifecycle of a standard or FIFO SQS queue. A queue name
 * is auto-generated from the app, stage, and logical ID unless you provide
 * one explicitly. FIFO queues automatically append the `.fifo` suffix.
 *
 * @section Creating Queues
 * @example Standard Queue
 * ```typescript
 * import * as SQS from "alchemy/AWS/SQS";
 *
 * const queue = yield* SQS.Queue("OrdersQueue");
 * ```
 *
 * @example FIFO Queue
 * ```typescript
 * const queue = yield* SQS.Queue("OrdersFifoQueue", {
 *   fifo: true,
 *   contentBasedDeduplication: true,
 * });
 * ```
 *
 * @example Queue with Custom Settings
 * ```typescript
 * const queue = yield* SQS.Queue("ProcessingQueue", {
 *   visibilityTimeout: 120,
 *   messageRetentionPeriod: 86400,
 *   receiveMessageWaitTimeSeconds: 20,
 * });
 * ```
 *
 * @section Sending Messages
 * Bind send operations in the init phase and use them in runtime
 * handlers.
 *
 * @example Send a message from a handler
 * ```typescript
 * // init
 * const sendMessage = yield* SQS.SendMessage.bind(queue);
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
 * @section Event Sources
 * Process messages from a queue using a Lambda event source mapping.
 * Messages are automatically deleted after successful processing.
 *
 * @example Process queue messages
 * ```typescript
 * // init
 * yield* SQS.messages(queue).process(
 *   Effect.fn(function* (message) {
 *     yield* Effect.log(`Received: ${message.body}`);
 *   }),
 * );
 * ```
 */
export const Queue = Resource<Queue>("AWS.SQS.Queue");

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;
      const createQueueName = Effect.fnUntraced(function* (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) {
        if (props.queueName) {
          return props.queueName;
        }
        const baseName = yield* createPhysicalName({
          id,
          maxLength: props.fifo ? 80 - ".fifo".length : 80,
        });
        return props.fifo ? `${baseName}.fifo` : baseName;
      });
      const createAttributes = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ) => {
        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: props.delaySeconds?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
          ReceiveMessageWaitTimeSeconds:
            props.receiveMessageWaitTimeSeconds?.toString(),
          VisibilityTimeout: props.visibilityTimeout?.toString(),
          Policy:
            bindings.length > 0
              ? JSON.stringify({
                  Version: "2012-10-17",
                  Statement: bindings.flatMap((p) => p.data.policyStatements),
                })
              : undefined,
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
      return Queue.Provider.of({
        stables: ["queueName", "queueUrl", "queueArn"],
        read: Effect.fn(function* ({ id, olds, output }) {
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
            Effect.catch(() => Effect.succeed({} as Record<string, string>)),
          );
          const attrs = {
            queueName,
            queueUrl: url,
            queueArn,
          };
          return (yield* hasAlchemyTags(id, tagsResp)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName = yield* createQueueName(id, olds);
          const newQueueName = yield* createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          output,
          session,
          bindings,
        }) {
          const queueName =
            output?.queueName ?? (yield* createQueueName(id, news));
          const queueArn =
            output?.queueArn ??
            (`arn:aws:sqs:${region}:${accountId}:${queueName}` as const);
          const desiredAttributes = createAttributes(news, bindings);
          const internalTags = yield* createInternalTags(id);

          // Observe — find the queue's URL or create it.
          //
          // We never trust a stale `output.queueUrl` blindly: if the queue was
          // deleted out-of-band, downstream API calls fail with
          // `QueueDoesNotExist` and we recreate. This keeps the reconciler
          // convergent regardless of the starting cloud state.
          let queueUrl = yield* sqs.getQueueUrl({ QueueName: queueName }).pipe(
            Effect.map((r) => r.QueueUrl!),
            Effect.catchTag("QueueDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );

          if (queueUrl === undefined) {
            // `createQueue` is idempotent for identical params; with different
            // params it raises `QueueNameExists`. We pass the desired attrs so
            // first-create lands fully configured, and tolerate the race where
            // a peer reconciler created it concurrently.
            queueUrl = yield* sqs
              .createQueue({
                QueueName: queueName,
                Attributes: desiredAttributes,
                tags: internalTags,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDeletedRecently",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.tapOutput((i) =>
                      session.note(
                        `Queue was deleted recently, retrying... ${i + 1}s`,
                      ),
                    ),
                  ),
                }),
                Effect.catchTag("QueueNameExists", () =>
                  sqs.getQueueUrl({ QueueName: queueName }),
                ),
                Effect.map((r) => r.QueueUrl!),
              );
          }

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
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
              Effect.map((r) => r.Attributes ?? {}),
            );

          const attributeDelta: Record<string, string> = {};
          for (const [key, value] of Object.entries(desiredAttributes)) {
            if (value === undefined) continue;
            if (
              currentAttributes[key as keyof typeof currentAttributes] !== value
            ) {
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
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
              );
          }

          // Sync alchemy-owned tags. The `tags` parameter on `createQueue`
          // only applies on first create, so on adoption (or after a queue
          // was created without our tags) we fix them up here.
          const currentTags = yield* sqs
            .listQueueTags({ QueueUrl: queueUrl })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
              Effect.map((r) => r.Tags ?? {}),
              Effect.catch(() => Effect.succeed({} as Record<string, string>)),
            );
          const tagDelta: Record<string, string> = {};
          for (const [key, value] of Object.entries(internalTags)) {
            if (currentTags[key] !== value) {
              tagDelta[key] = value;
            }
          }
          if (Object.keys(tagDelta).length > 0) {
            yield* sqs.tagQueue({ QueueUrl: queueUrl, Tags: tagDelta }).pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
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
          yield* sqs
            .deleteQueue({
              QueueUrl: input.output.queueUrl,
            })
            .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
        }),
      });
    }),
  );
