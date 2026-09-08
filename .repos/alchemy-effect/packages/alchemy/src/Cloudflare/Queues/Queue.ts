import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { detachQueueConsumersOfScript } from "./Consumer.ts";
import {
  generateLocalId,
  isLiveId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
  localRuntimeServices,
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
 * ### Creating a Queue
 * **Example:** Basic queue
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue");
 * ```
 *
 * **Example:** Queue with explicit name
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue", {
 *   name: "my-app-queue",
 * });
 * ```
 *
 * ### Binding to a Worker
 * In an Effect-style Worker, use `Cloudflare.Queues.WriteQueue` in
 * the init phase and provide `Cloudflare.Queues.WriteQueueBinding` in
 * the runtime layer. The returned `WriteQueueClient` exposes `send`
 * and `sendBatch`.
 *
 * **Example:** Sending messages from a Worker
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
 *
 * @resource
 * @product Queues
 * @category Storage & Databases
 */
export const Queue = Resource<Queue>("Cloudflare.Queues.Queue", {
  aliases: ["Cloudflare.Queue"],
});

export const ProviderLive = () =>
  Provider.succeed(Queue, {
    stables: ["queueId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
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
      // A `dev:` id (a mis-stamped legacy local row) is not a real queue id —
      // skip the lookup (Cloudflare rejects it as a malformed parameter) and
      // fall through to the name scan.
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
      // A `dev:` id means the physical resource only ever existed locally
      // (a mis-stamped legacy row) — there is nothing to delete, and the
      // API would reject the id as a malformed parameter.
      if (!isLiveId(output.queueId)) return;
      // Dependents (e.g. R2 event notification configs targeting this
      // queue) may still be tearing down concurrently — ride out the
      // dependency violation briefly, then fail loudly instead of
      // silently leaking the queue. A worker producer binding
      // (`QueueInUseByWorkerBinding`) gets a shorter window: a sibling
      // Worker's just-processed delete/unbind takes a few seconds to
      // propagate to the queues subsystem.
      const attempt = queues
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
          Effect.retry({
            while: (e) => e._tag === "QueueInUseByWorkerBinding",
            schedule: Schedule.max([
              Schedule.spaced("2 seconds"),
              Schedule.recurs(6),
            ]),
          }),
          Effect.catchTag("QueueNotFound", () => Effect.void),
        );
      yield* attempt.pipe(
        // Still pinned by a worker producer binding after the propagation
        // window: every *tracked* worker is deleted or unbound before its
        // queues by dependency order, so the referencing script is an
        // orphaned generation leaked by a pre-stamping dev run (a local-
        // stamped row whose real script was never deleted). Remove the
        // scripts that carry this stack+stage's ownership tags and retry;
        // a script from outside this stack+stage keeps the typed failure.
        Effect.catchTag("QueueInUseByWorkerBinding", (cause) =>
          Effect.gen(function* () {
            const removed = yield* deleteOwnedProducerScripts(
              output.accountId,
              output.queueId,
            );
            if (removed === 0) return yield* Effect.fail(cause);
            return yield* attempt;
          }),
        ),
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

/**
 * Delete the worker scripts that hold a producer binding on `queueId` AND
 * carry this stack+stage's `alchemy:` ownership tags. Returns how many
 * scripts were deleted.
 *
 * Used by the live queue delete when `QueueInUseByWorkerBinding` persists
 * past the propagation-lag retry window: tracked workers are always
 * deleted/unbound before their queues, so an own-stack script still
 * binding the queue at that point is an orphaned generation (leaked by a
 * pre-stamping dev run that rewrote the worker's row as local). Scripts
 * without our ownership tags are left alone.
 */
const deleteOwnedProducerScripts = Effect.fn(function* (
  accountId: string,
  queueId: string,
) {
  const stack = yield* Stack;
  const queue = yield* queues
    .getQueue({ accountId, queueId })
    .pipe(
      Effect.catchTag(["QueueNotFound", "InvalidRoute"], () =>
        Effect.succeed(undefined),
      ),
    );
  const producerScripts = Array.from(
    new Set(
      (queue?.producers ?? []).flatMap((producer) =>
        producer.type === "worker" &&
        "scriptName" in producer &&
        producer.scriptName
          ? [producer.scriptName]
          : [],
      ),
    ),
  );
  let removed = 0;
  for (const scriptName of producerScripts) {
    const settings = yield* workers
      .getScriptScriptAndVersionSetting({ accountId, scriptName })
      .pipe(
        Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () =>
          Effect.succeed(undefined),
        ),
      );
    const tags = new Set(settings?.tags ?? []);
    if (
      !tags.has(`alchemy:stack:${stack.name}`) ||
      !tags.has(`alchemy:stage:${stack.stage}`)
    ) {
      continue;
    }
    yield* Effect.logWarning(
      `Cloudflare Queue delete: removing orphaned worker script ` +
        `"${scriptName}" that still binds queue ${queueId} (leaked by a ` +
        `pre-providerMode dev run)`,
    );
    yield* workers.deleteScript({ accountId, scriptName, force: true }).pipe(
      // The orphan may also be registered as a queue consumer — detach
      // its consumers and retry, mirroring the Worker provider's own
      // delete recovery.
      Effect.catchTag("QueueConsumerConflict", () =>
        detachQueueConsumersOfScript(accountId, scriptName).pipe(
          Effect.andThen(
            workers.deleteScript({ accountId, scriptName, force: true }),
          ),
        ),
      ),
      Effect.catchTag("WorkerNotFound", () => Effect.void),
    );
    removed++;
  }
  return removed;
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
          // A real (non-`dev:`) queueId on a local-mode row is legacy damage:
          // pre-stamping dev runs preserved the live id, which the worker
          // binding then treats as an `Alchemy.remote()` queue and fails on
          // the missing producer shim. Replace so the new generation mints a
          // true local identity (delete best-effort removes the stray live
          // queue).
          if (isLiveId(output.queueId)) {
            return { action: "replace" };
          }
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
            // Never carry a real (non-`dev:`) id forward onto a local row —
            // the worker binding would treat it as an `Alchemy.remote()`
            // queue and fail on the missing producer shim.
            queueId:
              output?.queueId && !isLiveId(output.queueId)
                ? output.queueId
                : generateLocalId(),
            queueName: yield* createQueueName(id, news.name),
            accountId: output?.accountId ?? accountId,
          };
          MutableHashMap.set(localRuntimeState.queues, queue.queueId, queue);
          return queue;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(localRuntimeState.queues, output.queueId);
          // Legacy local-mode rows written before providerMode stamping can
          // carry a real queue's id — remove the live queue too so migrating
          // the row to a true local identity doesn't leak it.
          if (isLiveId(output.queueId)) {
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
                Effect.catchTag(
                  ["QueueNotFound", "InvalidRoute"],
                  () => Effect.void,
                ),
              );
          }
        }),
      };
    }),
  );

export const QueueProvider = () =>
  ProviderLayer.dual(Queue, {
    local: () => ProviderLocal().pipe(Layer.provide(localRuntimeServices())),
    live: () => ProviderLive(),
  });
