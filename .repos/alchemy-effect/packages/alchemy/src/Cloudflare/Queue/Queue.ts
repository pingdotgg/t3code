import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { QueueBinding } from "./QueueBinding.ts";

export const isQueue = (value: unknown): value is Queue =>
  typeof value === "object" && (value as any)?.Type === "Cloudflare.Queue";

export type QueueProps = {
  /**
   * Name of the queue. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type Queue = Resource<
  "Cloudflare.Queue",
  QueueProps,
  {
    queueId: string;
    queueName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Queue for reliable message passing between Workers.
 *
 * Queues enable you to send and receive messages with guaranteed delivery.
 * Create a queue as a resource, then bind it to a Worker to send messages
 * at runtime. Register a consumer to process messages.
 *
 * @section Creating a Queue
 * @example Basic queue
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue");
 * ```
 *
 * @example Queue with explicit name
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue", {
 *   name: "my-app-queue",
 * });
 * ```
 *
 * @section Binding to a Worker
 * In an Effect-style Worker, use `Cloudflare.QueueBinding.bind` in
 * the init phase and provide `Cloudflare.QueueBindingLive` in the
 * runtime layer. The returned `QueueSender` exposes `send` and
 * `sendBatch`.
 *
 * @example Sending messages from a Worker
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Queue = Cloudflare.Queue("Queue");
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const queue = yield* Cloudflare.QueueBinding.bind(Queue);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         if (request.url === "/queue/send" && request.method === "POST") {
 *           const text = yield* request.text;
 *           yield* queue.send({ text, sentAt: Date.now() }).pipe(Effect.orDie);
 *           return yield* HttpServerResponse.json(
 *             { sent: { text } },
 *             { status: 202 },
 *           );
 *         }
 *         return HttpServerResponse.text("Not Found", { status: 404 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.QueueBindingLive)),
 * );
 * ```
 */
export const Queue = Resource<Queue>("Cloudflare.Queue")({
  bind: QueueBinding.bind,
});

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createQueue = yield* queues.createQueue;
      const getQueue = yield* queues.getQueue;
      const deleteQueue = yield* queues.deleteQueue;

      const createQueueName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      // Cloudflare's `listQueues` accepts no name/prefix filter, so
      // adoption-by-name has to scan every page. Use the paginated
      // `.items` stream off the un-yielded operation method.
      const findQueueByName = (queueName: string) =>
        queues.listQueues.items({ accountId }).pipe(
          Stream.filter((q) => q.queueName === queueName),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      return {
        stables: ["queueId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createQueueName(id, news.name);
          const oldName = output?.queueName
            ? output.queueName
            : yield* createQueueName(id, olds.name);
          if (name !== oldName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const queueName = yield* createQueueName(id, news.name);
          const acct = output?.accountId ?? accountId;

          // Observe — re-fetch the cached queue; fall back to a name scan
          // when the cached id is gone (out-of-band delete or partial
          // state-persistence failure).
          let observed:
            | { queueId?: string | null; queueName?: string | null }
            | undefined;
          if (output?.queueId) {
            observed = yield* getQueue({
              accountId: acct,
              queueId: output.queueId,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          }
          if (!observed) {
            observed = yield* findQueueByName(queueName);
          }

          // Ensure — create if missing. Cloudflare returns a generic
          // failure when the queue name is taken; tolerate by adopting
          // the queue with the same name so reconciles converge after a
          // crashed peer.
          if (!observed) {
            observed = yield* createQueue({
              accountId: acct,
              queueName,
            }).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  const match = yield* findQueueByName(queueName);
                  if (match && match.queueId && match.queueName) {
                    return match;
                  }
                  return yield* Effect.die(
                    `Queue "${queueName}" already exists but could not be found`,
                  );
                }),
              ),
            );
          }

          // Sync — Cloudflare Queues have no mutable per-queue settings
          // here (the queue name itself is treated as a replace by diff),
          // so observed state is the answer.
          return {
            queueId: observed.queueId!,
            queueName: observed.queueName!,
            accountId: acct,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteQueue({
            accountId: output.accountId,
            queueId: output.queueId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.queueId) {
            return yield* getQueue({
              accountId: output.accountId,
              queueId: output.queueId,
            }).pipe(
              Effect.map((queue) => ({
                queueId: queue.queueId!,
                queueName: queue.queueName!,
                accountId: output.accountId,
              })),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }
          const queueName = yield* createQueueName(id, olds?.name);
          const match = yield* findQueueByName(queueName);
          if (match && match.queueId && match.queueName) {
            return {
              queueId: match.queueId,
              queueName: match.queueName,
              accountId,
            };
          }
          return undefined;
        }),
      };
    }),
  );
