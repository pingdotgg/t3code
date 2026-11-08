import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as RpcProvider from "alchemy/Local/RpcProvider";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import {
  generateLocalId,
  isLiveId,
  LOCAL_PROVIDERS_URL,
  LocalRuntimeState,
  localRuntimeServices,
} from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import { detachQueueConsumersOfScript } from "./Consumer.ts";

export const isQueue = (value: unknown): value is Queue =>
  isResourceOfType(value, "Cloudflare.Queues.Queue");

/**
 * Where Cloudflare stores and processes a queue's messages.
 */
export type QueueJurisdiction = "eu" | "us" | "fedramp";

export type QueueProps = {
  /**
   * Name of the queue. If omitted, a unique name will be generated.
   * Queue names are unique per account across all jurisdictions.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Restrict where Cloudflare stores and processes the queue's messages.
   * Workers can still produce to and consume from it from any location.
   * Cloudflare only accepts it when the queue is created, so changing it
   * replaces the queue and drops the messages still in it. A dead-letter
   * queue must be in the same jurisdiction as its source queue.
   * @default undefined (global)
   */
  jurisdiction?: QueueJurisdiction;
  /**
   * Seconds an unconsumed message is kept before it is deleted. Cloudflare
   * allows 60 seconds to 14 days (1209600). Workers Free plans can't change it.
   * Removing it resets it to the default.
   * @default 345600 (4 days)
   */
  messageRetentionPeriod?: number;
  /**
   * Seconds to delay delivery of every message to consumers, from 0 to 86400 (24 hours).
   * Removing it resets it to the default.
   * @default 0
   */
  deliveryDelay?: number;
  /**
   * Pause delivery of messages to consumers. Producers can still send.
   * Removing it resets it to the default.
   * @default false
   */
  deliveryPaused?: boolean;
};

type QueueSettings = Pick<
  QueueProps,
  "messageRetentionPeriod" | "deliveryDelay" | "deliveryPaused"
>;

/**
 * The queue found by name is in a different jurisdiction than the one
 * declared. Cloudflare can't move a queue between jurisdictions, so it is
 * not adopted.
 */
export class QueueJurisdictionMismatch extends Data.TaggedError("QueueJurisdictionMismatch")<{
  readonly message: string;
  readonly queueName: string;
  readonly expected: QueueJurisdiction | undefined;
  readonly actual: QueueJurisdiction | undefined;
}> {}

export type Queue = Resource<
  "Cloudflare.Queues.Queue",
  QueueProps,
  {
    queueId: string;
    queueName: string;
    accountId: string;
    /** The queue's jurisdiction, or `undefined` for a global queue. */
    jurisdiction: QueueJurisdiction | undefined;
    /** Seconds an unconsumed message is kept before it is deleted. */
    messageRetentionPeriod: number;
    /** Seconds delivery of every message to consumers is delayed. */
    deliveryDelay: number;
    /** Whether delivery of messages to consumers is paused. */
    deliveryPaused: boolean;
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
 * ### Configuring Settings
 * Durations are in seconds, matching the Cloudflare API. A setting you
 * never declare keeps whatever value the queue already has.
 *
 * **Example:** Dead-letter queue that keeps messages for 14 days
 * ```typescript
 * const deadLetters = yield* Cloudflare.Queues.Queue("DeadLetters", {
 *   messageRetentionPeriod: 14 * 24 * 60 * 60,
 * });
 * ```
 *
 * **Example:** Delay and pause delivery
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue", {
 *   deliveryDelay: 30,
 *   deliveryPaused: true,
 * });
 * ```
 *
 * ### Data Residency
 * **Example:** Queue restricted to the EU
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("EuQueue", {
 *   jurisdiction: "eu",
 * });
 * const deadLetters = yield* Cloudflare.Queues.Queue("EuDeadLetters", {
 *   jurisdiction: "eu",
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
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
      const oldName = output?.queueName ?? (yield* createQueueName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      const oldJurisdiction = output ? output.jurisdiction : olds.jurisdiction;
      if (name !== oldName || oldJurisdiction !== news.jurisdiction) {
        // Queue names are unique per account across jurisdictions, so a
        // replacement that keeps an explicit name can't coexist with its
        // predecessor. Delete the old generation first. Generated names
        // change with the new instance id, so they stay create-first.
        return news.name !== undefined && news.name === oldName
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const queueName = yield* createQueueName(id, news.name);
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached queue; fall back to a name scan
      // when the cached id is gone (out-of-band delete or partial
      // state-persistence failure).
      let observed: ObservedQueue | undefined;
      // A `dev:` id (a mis-stamped legacy local row) is not a real queue id —
      // skip the lookup (Cloudflare rejects it as a malformed parameter) and
      // fall through to the name scan.
      if (output?.queueId && isLiveId(output.queueId)) {
        observed = yield* queues
          .getQueue({
            accountId: acct,
            queueId: output.queueId,
          })
          .pipe(Effect.catchTag(["QueueNotFound", "InvalidRoute"], () => Effect.undefined));
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
            jurisdiction: news.jurisdiction,
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

      // Jurisdiction is create-only. A queue found by name (adoption, a
      // crashed peer) in another jurisdiction can't be converged.
      const jurisdiction = toJurisdiction(observed.jurisdiction);
      if (jurisdiction !== news.jurisdiction) {
        return yield* new QueueJurisdictionMismatch({
          message:
            `Queue "${queueName}" exists in jurisdiction ${jurisdiction ?? "global"}, ` +
            `not ${news.jurisdiction ?? "global"}. A queue's jurisdiction can't be changed.`,
          queueName,
          expected: news.jurisdiction,
          actual: jurisdiction,
        });
      }

      // Sync settings — diff the observed settings against the declared
      // ones and patch only the delta.
      const current = toSettings(observed.settings);
      const desired = desiredSettings(news, olds);
      const delta: QueueSettings = {};
      for (const key of Object.keys(desired) as (keyof QueueSettings)[]) {
        if (desired[key] !== undefined && desired[key] !== current[key]) {
          (delta as Record<string, unknown>)[key] = desired[key];
        }
      }
      let settings = current;
      if (Object.keys(delta).length > 0) {
        const patched = yield* queues.patchQueue({
          accountId: acct,
          queueId: observed.queueId!,
          settings: delta,
        });
        settings = toSettings(patched.settings);
      }

      return {
        queueId: observed.queueId!,
        queueName: observed.queueName!,
        accountId: acct,
        jurisdiction,
        ...settings,
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
            schedule: Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(8)]),
          }),
          Effect.retry({
            while: (e) => e._tag === "QueueInUseByWorkerBinding",
            schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(6)]),
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
            const removed = yield* deleteOwnedProducerScripts(output.accountId, output.queueId);
            if (removed === 0) return yield* cause;
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
              .map((q) => toAttributes(q, accountId)),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, output, olds, previous }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.queueId && isLiveId(output.queueId)) {
        return yield* queues
          .getQueue({
            accountId: output.accountId,
            queueId: output.queueId,
          })
          .pipe(
            Effect.map((queue) => toAttributes(queue, output.accountId)),
            Effect.catchTag(["QueueNotFound", "InvalidRoute"], () => Effect.undefined),
          );
      }
      const queueName = yield* createQueueName(id, olds?.name);
      const match = yield* findQueueByName(queueName);
      if (match && match.queueId && match.queueName) {
        // A queue in another jurisdiction can't be converged, only
        // replaced — and replacing it deletes whatever owns that name.
        // Report it as foreign so the engine refuses it without `--adopt`
        // (and still admits our own previous generation on replacement).
        const attrs = toAttributes(match, accountId);
        return attrs.jurisdiction !== olds?.jurisdiction && attrs.queueId !== previous?.queueId
          ? Unowned(attrs)
          : attrs;
      }
      return undefined;
    }),
  });

type ObservedQueue = {
  queueId?: string | null;
  queueName?: string | null;
  jurisdiction?: string | null;
  settings?: {
    messageRetentionPeriod?: number | null;
    deliveryDelay?: number | null;
    deliveryPaused?: boolean | null;
  } | null;
};

const DEFAULT_SETTINGS: Required<QueueSettings> = {
  messageRetentionPeriod: 345600,
  deliveryDelay: 0,
  deliveryPaused: false,
};

// Cloudflare omits `jurisdiction` for a global queue and `deliveryPaused`
// while delivery runs.
const toJurisdiction = (jurisdiction: string | null | undefined) =>
  (jurisdiction || undefined) as QueueJurisdiction | undefined;

const toSettings = (settings: ObservedQueue["settings"]): Required<QueueSettings> => ({
  messageRetentionPeriod:
    settings?.messageRetentionPeriod ?? DEFAULT_SETTINGS.messageRetentionPeriod,
  deliveryDelay: settings?.deliveryDelay ?? DEFAULT_SETTINGS.deliveryDelay,
  deliveryPaused: settings?.deliveryPaused ?? DEFAULT_SETTINGS.deliveryPaused,
});

/**
 * The settings to converge to: every declared setting, plus the Cloudflare
 * default for each setting that was declared before and has been removed.
 * Settings never declared are left as they are.
 */
const desiredSettings = (
  news: QueueSettings | undefined,
  olds: QueueSettings | undefined,
): QueueSettings => {
  const desired: QueueSettings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof QueueSettings)[]) {
    const value = news?.[key] ?? (olds?.[key] !== undefined ? DEFAULT_SETTINGS[key] : undefined);
    if (value !== undefined) (desired as Record<string, unknown>)[key] = value;
  }
  return desired;
};

const toAttributes = (
  queue: ObservedQueue & { queueId?: string | null; queueName?: string | null },
  accountId: string,
): Queue["Attributes"] => ({
  queueId: queue.queueId!,
  queueName: queue.queueName!,
  accountId,
  jurisdiction: toJurisdiction(queue.jurisdiction),
  ...toSettings(queue.settings),
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
const deleteOwnedProducerScripts = Effect.fn(function* (accountId: string, queueId: string) {
  const stack = yield* Stack;
  const queue = yield* queues
    .getQueue({ accountId, queueId })
    .pipe(Effect.catchTag(["QueueNotFound", "InvalidRoute"], () => Effect.undefined));
  const producerScripts = Array.from(
    new Set(
      (queue?.producers ?? []).flatMap((producer) =>
        producer.type === "worker" && "scriptName" in producer && producer.scriptName
          ? [producer.scriptName]
          : [],
      ),
    ),
  );
  let removed = 0;
  for (const scriptName of producerScripts) {
    const settings = yield* workers
      .getScriptScriptAndVersionSetting({ accountId, scriptName })
      .pipe(Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () => Effect.undefined));
    const tags = new Set(settings?.tags ?? []);
    if (!tags.has(`alchemy:stack:${stack.name}`) || !tags.has(`alchemy:stage:${stack.stage}`)) {
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
          Effect.andThen(workers.deleteScript({ accountId, scriptName, force: true })),
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
    LOCAL_PROVIDERS_URL,
    Effect.gen(function* () {
      const localRuntimeState = yield* LocalRuntimeState;
      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          const accountId = yield* localAccountId;
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
          if (
            name !== oldName ||
            output.accountId !== accountId ||
            output.jurisdiction !== news.jurisdiction
          ) {
            return { action: "replace" };
          }
          const settings = toSettings(news);
          if (
            (Object.keys(settings) as (keyof QueueSettings)[]).some(
              (key) => settings[key] !== output[key],
            )
          ) {
            return { action: "update" };
          }
          // If the resource is a noop, add it to the local runtime state so it's available downstream.
          // We do it here instead of in the reconcile function so it doesn't appear as an update.
          MutableHashMap.set(localRuntimeState.queues, output.queueId, output);
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.queueId) return undefined;
          return MutableHashMap.get(localRuntimeState.queues, output.queueId).pipe(
            Option.getOrUndefined,
          );
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const accountId = yield* localAccountId;
          const queue: Queue["Attributes"] = {
            // Never carry a real (non-`dev:`) id forward onto a local row —
            // the worker binding would treat it as an `Alchemy.remote()`
            // queue and fail on the missing producer shim.
            queueId:
              output?.queueId && !isLiveId(output.queueId) ? output.queueId : generateLocalId(),
            queueName: yield* createQueueName(id, news.name),
            accountId: output?.accountId ?? accountId,
            jurisdiction: news.jurisdiction,
            ...toSettings(news),
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
                  schedule: Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(8)]),
                }),
                Effect.catchTag(["QueueNotFound", "InvalidRoute"], () => Effect.void),
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
