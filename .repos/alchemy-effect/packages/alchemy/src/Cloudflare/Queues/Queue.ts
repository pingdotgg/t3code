import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  generateLocalId,
  isLiveId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
} from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";

export const isQueue = (value: unknown): value is Queue =>
  isResourceOfType(value, "Cloudflare.Queues.Queue");

export type QueueProps = {
  /**
   * Name of the queue. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
};

export type Queue = Resource<
  "Cloudflare.Queues.Queue",
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
 * @resource
 * @product Queues
 * @category Storage & Databases
 * @section Creating a Queue
 * @example Basic queue
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue");
 * ```
 *
 * @example Queue with explicit name
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue", {
 *   name: "my-app-queue",
 * });
 * ```
 *
 * @section Binding to a Worker
 * In an Effect-style Worker, use `Cloudflare.Queues.WriteQueue` in
 * the init phase and provide `Cloudflare.Queues.WriteQueueBinding` in
 * the runtime layer. The returned `WriteQueueClient` exposes `send`
 * and `sendBatch`.
 *
 * @example Sending messages from a Worker
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Queue = Cloudflare.Queues.Queue("Queue");
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Cloudflare.Queues.WriteQueue(Queue);
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
 *   }).pipe(Effect.provide(Cloudflare.Queues.WriteQueueBinding)),
 * );
 * ```
 */
export const Queue = Resource<Queue>("Cloudflare.Queues.Queue", {
  aliases: ["Cloudflare.Queue"],
});

export const ProviderLive = () =>
  Provider.succeed(Queue, {
    // The `queueId` is not marked as stable because if you start in dev mode, the ID will change on first deploy.
    stables: ["accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // If the queueId is a `dev:` ID, we need to update to a live one.
      // The live resource doesn't exist yet, so there's no need to replace even if the name or accountId changed.
      if (!isLiveId(output?.queueId)) {
        return { action: "update" };
      }
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.queueName ?? (yield* createQueueName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (name !== oldName) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const queueName = yield* createQueueName(id, news.name);
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached queue; fall back to a name scan
      // when the cached id is gone (out-of-band delete or partial
      // state-persistence failure).
      let observed:
        | { queueId?: string | null; queueName?: string | null }
        | undefined;
      // A `dev:` id never exists on Cloudflare — skip straight to the
      // name scan (promotion from dev to live).
      if (output?.queueId && isLiveId(output.queueId)) {
        observed = yield* queues
          .getQueue({
            accountId: acct,
            queueId: output.queueId,
          })
          .pipe(
            Effect.catchTag(["QueueNotFound", "InvalidRoute"], () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (!observed) {
        observed = yield* findQueueByName(queueName);
      }

      // Ensure — create if missing. Cloudflare returns a generic
      // failure when the queue name is taken; tolerate by adopting
      // the queue with the same name so reconciles converge after a
      // crashed peer.
      if (!observed) {
        observed = yield* queues
          .createQueue({
            accountId: acct,
            queueName,
          })
          .pipe(
            Effect.catchTag("QueueAlreadyExists", () =>
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
      // If the queueId is a `dev:` ID, the resource only exists locally, so we don't need to delete it from Cloudflare.
      if (!isLiveId(output.queueId)) return;
      // Dependents (e.g. R2 event notification configs targeting this
      // queue) may still be tearing down concurrently — ride out the
      // dependency violation briefly, then fail loudly instead of
      // silently leaking the queue.
      yield* queues
        .deleteQueue({
          accountId: output.accountId,
          queueId: output.queueId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "QueueInUseByEventNotification",
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("QueueNotFound", () => Effect.void),
        );
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* queues.listQueues.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (q): q is typeof q & { queueId: string; queueName: string } =>
                  q.queueId != null && q.queueName != null,
              )
              .map((q) => ({
                queueId: q.queueId,
                queueName: q.queueName,
                accountId,
              })),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.queueId && isLiveId(output.queueId)) {
        return yield* queues
          .getQueue({
            accountId: output.accountId,
            queueId: output.queueId,
          })
          .pipe(
            Effect.map((queue) => ({
              queueId: queue.queueId!,
              queueName: queue.queueName!,
              accountId: output.accountId,
            })),
            Effect.catchTag(["QueueNotFound", "InvalidRoute"], () =>
              Effect.succeed(undefined),
            ),
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
  });

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
const findQueueByName = Effect.fn(function* (queueName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* queues.listQueues.items({ accountId }).pipe(
    Stream.filter((q) => q.queueName === queueName),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
});

export const ProviderLocal = () =>
  RpcProvider.effect(
    Queue,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const localRuntimeState = yield* LocalRuntimeState;
      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          if (!output?.queueId) return { action: "update" };
          if (!isResolved(news)) return undefined;
          const name = yield* createQueueName(id, news.name);
          const oldName = output?.queueName
            ? yield* createQueueName(id, olds.name)
            : yield* createQueueName(id, olds.name);
          if (name !== oldName || output.accountId !== accountId) {
            return { action: "replace" };
          }
          // If the resource is a noop, add it to the local runtime state so it's available downstream.
          // We do it here instead of in the reconcile function so it doesn't appear as an update.
          MutableHashMap.set(localRuntimeState.queues, output.queueId, output);
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.queueId) return undefined;
          return MutableHashMap.get(
            localRuntimeState.queues,
            output.queueId,
          ).pipe(Option.getOrUndefined);
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const queue: Queue["Attributes"] = {
            queueId: output?.queueId ?? generateLocalId(),
            queueName: yield* createQueueName(id, news.name),
            accountId: output?.accountId ?? accountId,
          };
          MutableHashMap.set(localRuntimeState.queues, queue.queueId, queue);
          return queue;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(localRuntimeState.queues, output.queueId);
        }),
      };
    }),
  );

export const QueueProvider = () =>
  ProviderLayer.select({
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
