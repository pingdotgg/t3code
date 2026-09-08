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
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  isLiveId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
  localRuntimeServices,
} from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";

export type ConsumerProps = {
  /**
   * The queue ID to attach the consumer to.
   */
  queueId: string;
  /**
   * Name of the Worker script that will consume messages.
   */
  scriptName: string;
  /**
   * Optional dead letter queue name for failed messages.
   */
  deadLetterQueue?: string;
  /**
   * Consumer settings.
   */
  settings?: ConsumerSettings;
};

export interface ConsumerSettings {
  /**
   * The maximum number of messages per batch.
   * @default 10
   */
  batchSize?: number;
  /**
   * The maximum number of concurrent consumer invocations.
   */
  maxConcurrency?: number;
  /**
   * The maximum number of retries for a message.
   * @default 3
   */
  maxRetries?: number;
  /**
   * The maximum time to wait for a batch to fill, in milliseconds.
   * @default 5000
   */
  maxWaitTimeMs?: number;
  /**
   * The number of seconds to wait before retrying a message.
   */
  retryDelay?: number;
}

export type Consumer = Resource<
  "Cloudflare.Queues.Consumer",
  ConsumerProps,
  {
    consumerId: string;
    queueId: string;
    scriptName: string;
    accountId: string;
    deadLetterQueue?: string;
    settings?: ConsumerSettings;
    /**
     * Dev only, live queues only: the real queue's name, resolved from the
     * cloud so the local runtime can wire the broker + pull loop for a
     * locally-running consumer of an `Alchemy.remote()` queue.
     */
    queueName?: string;
    /**
     * Dev only, live queues only: id of the `http_pull` consumer attached
     * to the real queue so the local runtime can drain it via the HTTP
     * pull API. Deleted when this resource is deleted.
     */
    pullConsumerId?: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Queue Consumer that processes messages from a Queue.
 *
 * Register a Worker as a consumer of a Queue. The Worker's `queue()`
 * handler will be invoked with batches of messages.
 *
 * Cloudflare allows at most one Worker consumer per queue (HTTP-pull
 * consumers can coexist). The reconciler enforces this: if the queue
 * already has a Worker consumer pointing at a different logical Worker's
 * script, the deploy fails with a clear error rather than silently
 * adopting it. A stranded consumer from a prior generation of the *same*
 * Worker (identified by the scripts' ownership tags) is rebuilt in place.
 * ### Registering a Consumer
 * **Example:** Basic consumer
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("MyQueue");
 * const worker = yield* Cloudflare.Worker("Worker", { ... });
 *
 * yield* Cloudflare.Queues.Consumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: worker.workerName,
 * });
 * ```
 *
 * **Example:** Consumer with settings
 * ```typescript
 * yield* Cloudflare.Queues.Consumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: worker.workerName,
 *   settings: {
 *     batchSize: 50,
 *     maxRetries: 5,
 *     maxWaitTimeMs: 10000,
 *   },
 * });
 * ```
 *
 * @resource
 * @product Queues
 * @category Storage & Databases
 */
export const Consumer = Resource<Consumer>("Cloudflare.Queues.Consumer", {
  aliases: ["Cloudflare.QueueConsumer"],
});

/**
 * Find and detach every worker queue-consumer pointing at `scriptName`.
 * Queue consumers have no by-script lookup, so scan the account's queues
 * (the list response inlines each queue's consumers). Waits until each
 * detach propagates to the workers subsystem so a follow-up deleteScript
 * doesn't re-race the conflict.
 *
 * Shared by the Worker provider's script delete (QueueConsumerConflict
 * recovery) and the Queue provider's orphaned-script cleanup.
 *
 * @internal
 */
export const detachQueueConsumersOfScript = Effect.fn(function* (
  accountId: string,
  scriptName: string,
) {
  const pages = yield* queues.listQueues.pages({ accountId }).pipe(
    Stream.runCollect,
    Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
  );
  const targets = Array.from(pages).flatMap((page) =>
    (page.result ?? []).flatMap((queue) =>
      (queue.consumers ?? []).flatMap((consumer) =>
        queue.queueId &&
        consumer.type === "worker" &&
        consumer.consumerId &&
        "scriptName" in consumer &&
        consumer.scriptName === scriptName
          ? [{ queueId: queue.queueId, consumerId: consumer.consumerId }]
          : [],
      ),
    ),
  );
  yield* Effect.forEach(
    targets,
    ({ queueId, consumerId }) =>
      queues.deleteConsumer({ accountId, queueId, consumerId }).pipe(
        Effect.catchTag(
          ["ConsumerNotFound", "QueueNotFound"],
          () => Effect.void,
        ),
        Effect.andThen(
          queues.getConsumer({ accountId, queueId, consumerId }).pipe(
            Effect.flatMap(() => Effect.fail("still-attached" as const)),
            Effect.catchTag(
              ["ConsumerNotFound", "QueueNotFound"],
              () => Effect.void,
            ),
            Effect.retry({
              while: (e) => e === "still-attached",
              schedule: Schedule.max([
                Schedule.spaced("1 second"),
                Schedule.recurs(30),
              ]),
            }),
            Effect.ignore,
          ),
        ),
      ),
    { concurrency: 5, discard: true },
  );
});

// Cloudflare allows a single Worker consumer per queue, so the
// first match in the paginated stream is the only one. Using
// `.items` defeats single-page lookups that would otherwise
// miss late-arriving consumers under eventual consistency.
const findWorkerConsumer = (acct: string, queueId: string) =>
  queues.listConsumers.items({ accountId: acct, queueId }).pipe(
    Stream.map(toObserved),
    Stream.filter((c): c is ObservedConsumer => c !== undefined),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    // A queue created earlier in the same plan is eventually consistent:
    // listConsumers can transiently 404 (`QueueNotFound`, code 11000) before
    // the fresh queue is visible to the consumers API. Treat that as "no
    // consumer yet" — the caller falls through to createConsumer, which
    // retries QueueNotFound until the queue propagates.
    Effect.catchTag("QueueNotFound", () => Effect.succeed(undefined)),
  );

export const ConsumerProviderLive = () =>
  Provider.succeed(Consumer, {
    // The `consumerId` is not marked as stable because if you start in dev mode, the ID will change on first deploy.
    stables: ["accountId"],
    // Queue consumers are sub-resources of a queue with no account-wide
    // enumeration API, so fan out: list every queue in the account, then
    // list each queue's consumers and keep the worker ones (the only kind
    // this resource manages, matching `read`/`reconcile`).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const queueIds = yield* queues.listQueues.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map((q) => q.queueId)
              .filter((id): id is string => id != null),
          ),
        ),
        // Account not entitled for Queues — nothing to enumerate.
        Effect.catchTag("InvalidRoute", () => Effect.succeed<string[]>([])),
      );
      const rows = yield* Effect.forEach(
        queueIds,
        (queueId) =>
          queues.listConsumers.pages({ accountId, queueId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).flatMap((c): Consumer["Attributes"][] => {
                  if (c.type !== "worker" || !c.consumerId) return [];
                  const s = c.settings ?? undefined;
                  return [
                    {
                      consumerId: c.consumerId,
                      queueId,
                      scriptName: c.scriptName ?? "",
                      accountId,
                      deadLetterQueue: c.deadLetterQueue ?? undefined,
                      settings: s
                        ? {
                            batchSize: s.batchSize ?? undefined,
                            maxConcurrency: s.maxConcurrency ?? undefined,
                            maxRetries: s.maxRetries ?? undefined,
                            maxWaitTimeMs: s.maxWaitTimeMs ?? undefined,
                            retryDelay: s.retryDelay ?? undefined,
                          }
                        : undefined,
                    },
                  ];
                }),
              ),
            ),
            // Queue deleted mid-list or partial entitlement — skip it.
            Effect.catchTag(["QueueNotFound", "InvalidRoute"], () =>
              Effect.succeed<Consumer["Attributes"][]>([]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // If either contain `dev:` IDs, we need to update to live ones.
      // The live resource doesn't exist yet, so there's no need to replace even when we otherwise would.
      if (!isLiveId(output?.queueId) || !isLiveId(output?.consumerId)) {
        return { action: "update" };
      }
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Queue change requires replacement — consumerId is bound
      // to a queue and the API has no "move consumer" verb.
      if (output?.queueId && news.queueId !== output.queueId) {
        return { action: "replace", deleteFirst: true } as const;
      }
      // Settings / DLQ / script drift is an update. We DON'T
      // escalate scriptName changes to `replace` because the
      // engine resolves cross-resource Output<string> refs (a
      // sibling Worker's `workerName`) lazily — when the upstream
      // Worker is created in the same plan, `news` is partially
      // unresolved at diff time and `isResolved(news)` short-
      // circuits up top. Falling through to "update" lets the
      // engine call reconcile with fully-resolved `news`, where
      // we detect script drift and rebuild the consumer in
      // place (Cloudflare's PUT silently ignores `script_name`
      // changes, so reconcile does delete-then-create).
      if (
        JSON.stringify(olds.settings ?? {}) !==
          JSON.stringify(news.settings ?? {}) ||
        (olds.deadLetterQueue ?? undefined) !==
          (news.deadLetterQueue ?? undefined) ||
        (output?.scriptName !== undefined &&
          news.scriptName !== output.scriptName)
      ) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Only use `output.queueId` if it's a live ID (i.e. no `dev:` prefix).
      // Otherwise, the lookup will fail because the request is malformed.
      const queueId = isLiveId(output?.queueId) ? output.queueId : news.queueId;

      // Delete a consumer and wait for Cloudflare's worker subsystem to
      // drop its claim on the old script so createConsumer below doesn't
      // race the queue↔script propagation lag.
      const detachConsumer = Effect.fn(function* (consumerId: string) {
        yield* queues
          .deleteConsumer({ accountId: acct, queueId, consumerId })
          .pipe(Effect.catchTag("ConsumerNotFound", () => Effect.void));
        yield* queues
          .getConsumer({ accountId: acct, queueId, consumerId })
          .pipe(
            Effect.flatMap(() => Effect.fail("still-attached" as const)),
            Effect.catchTag("ConsumerNotFound", () => Effect.void),
            Effect.retry({
              while: (e) => e === "still-attached",
              schedule: Schedule.max([
                Schedule.spaced("1 second"),
                Schedule.recurs(30),
              ]),
            }),
            Effect.ignore,
          );
      });

      // Observe — prefer the cached consumerId, then fall back to
      // listConsumers (paginated) to recover from out-of-band
      // deletes or partial state-persistence failures. Track
      // whether the observation came from the cached id or the
      // list scan: a different-script worker consumer found via
      // the list scan is potentially foreign (state was lost,
      // someone else attached the consumer), and silently
      // updating it could clobber another team's wiring.
      let observed: ObservedConsumer | undefined;
      let owned = false;
      if (isLiveId(output?.consumerId)) {
        const fetched = yield* queues
          .getConsumer({
            accountId: acct,
            queueId,
            consumerId: output.consumerId,
          })
          .pipe(
            Effect.catchTag("ConsumerNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (fetched) {
          observed = toObserved(fetched);
          owned = observed !== undefined;
        }
      }
      if (!observed) {
        observed = yield* findWorkerConsumer(acct, queueId);
      }

      // Owned consumer pointing at a different script: rebuild
      // it in place. Cloudflare's PUT consumer silently ignores
      // `script_name` changes on existing consumers (the live
      // record stays pinned to the original worker), and the
      // platform allows only one Worker consumer per queue, so
      // the only path to re-point is delete-then-create.
      if (
        owned &&
        observed &&
        observed.scriptName !== undefined &&
        observed.scriptName !== news.scriptName
      ) {
        yield* detachConsumer(observed.consumerId);
        observed = undefined;
        owned = false;
      }

      // A consumer found via the list scan (state loss) pointing at a
      // different script. Probe the script it points at: when it no
      // longer exists, or is a *prior generation of the same logical
      // Worker* (same `alchemy:stack/stage/id` ownership tags as the
      // configured script — replacements mint a new physical name, and
      // a crashed apply can strand the old generation's consumer with
      // its state entry lost), the wiring is ours to rebuild. Any other
      // script — another team's, or a *different* Worker in this stack
      // (a real misconfiguration: two consumers declared for one queue)
      // — is refused loudly rather than silently stolen.
      if (
        observed &&
        !owned &&
        observed.scriptName !== undefined &&
        observed.scriptName !== news.scriptName
      ) {
        const scriptTags = Effect.fn(function* (scriptName: string) {
          const settings = yield* workers
            .getScriptScriptAndVersionSetting({
              accountId: acct,
              scriptName,
            })
            .pipe(
              Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () =>
                Effect.succeed(undefined),
              ),
            );
          return settings === undefined
            ? undefined
            : new Set(settings.tags ?? []);
        });
        const observedTags = yield* scriptTags(observed.scriptName);
        let staleGeneration = observedTags === undefined;
        if (observedTags !== undefined) {
          const stack = yield* Stack;
          const desiredTags = news.scriptName
            ? yield* scriptTags(news.scriptName)
            : undefined;
          const observedId = Array.from(observedTags).find((t) =>
            t.startsWith("alchemy:id:"),
          );
          staleGeneration =
            observedId !== undefined &&
            observedTags.has(`alchemy:stack:${stack.name}`) &&
            observedTags.has(`alchemy:stage:${stack.stage}`) &&
            desiredTags !== undefined &&
            desiredTags.has(observedId) &&
            desiredTags.has(`alchemy:stack:${stack.name}`) &&
            desiredTags.has(`alchemy:stage:${stack.stage}`);
        }
        if (!staleGeneration) {
          return yield* Effect.die(
            `Cloudflare queue "${queueId}" already has a worker ` +
              `consumer for script "${observed.scriptName}", but this ` +
              `resource is configured for "${news.scriptName}" and ` +
              `local state for the consumer was missing. Each queue ` +
              `can have only one worker consumer — delete the ` +
              `existing one, update scriptName to match, or restore ` +
              `the consumer's state entry before redeploying.`,
          );
        }
        yield* detachConsumer(observed.consumerId);
        observed = undefined;
      }

      // Ensure — create if missing. ConsumerAlreadyExists is the
      // race signal: another reconcile or peer beat us to it.
      // Re-run the lookup; the paginated stream tolerates the
      // single-page eventual-consistency window the previous
      // implementation missed.
      let consumerId: string;
      if (!observed) {
        const created = yield* queues
          .createConsumer({
            accountId: acct,
            queueId,
            scriptName: news.scriptName,
            type: "worker",
            deadLetterQueue: news.deadLetterQueue,
            settings: news.settings,
          })
          .pipe(
            // Two eventual-consistency races on a fresh deploy, both
            // retried on the same bounded schedule:
            //  - QueueHandlerMissing (11001): the sibling Worker resource
            //    pre-creates a placeholder script with no `queue` handler;
            //    Cloudflare returns 11001 until the real reconcile uploads
            //    the handler.
            //  - QueueNotFound (11000): the queue was created earlier in
            //    this same plan but isn't yet visible to the consumers API.
            Effect.tapError((e) =>
              e._tag === "QueueHandlerMissing" || e._tag === "QueueNotFound"
                ? Effect.logDebug(
                    `Consumer create: not ready for worker ` +
                      `"${news.scriptName}" (${e._tag}), retrying`,
                  )
                : Effect.void,
            ),
            Effect.retry({
              while: (e) =>
                e._tag === "QueueHandlerMissing" || e._tag === "QueueNotFound",
              schedule: queueHandlerReadinessSchedule,
            }),
            Effect.catchTag("ConsumerAlreadyExists", (cause) =>
              Effect.gen(function* () {
                const match = yield* findWorkerConsumer(acct, queueId);
                if (!match) {
                  return yield* Effect.die(
                    `Cloudflare reported a worker consumer already ` +
                      `exists on queue "${queueId}", but listConsumers ` +
                      `returned none. Retry the deploy; if this ` +
                      `persists, the queue is in an inconsistent ` +
                      `state. Underlying error: ${cause.message}`,
                  );
                }
                if (
                  match.scriptName !== undefined &&
                  match.scriptName !== news.scriptName
                ) {
                  return yield* Effect.die(
                    `Cloudflare queue "${queueId}" already has a ` +
                      `worker consumer for script "${match.scriptName}", ` +
                      `but this resource is configured for ` +
                      `"${news.scriptName}". Each queue can have only ` +
                      `one worker consumer — delete the existing one ` +
                      `or update scriptName to match before redeploying.`,
                  );
                }
                return match;
              }),
            ),
          );
        consumerId = created.consumerId!;
      } else {
        consumerId = observed.consumerId;
      }

      // Sync — Cloudflare replaces all mutable fields on
      // updateConsumer, so always issue this so adoption converges
      // and settings drift gets corrected on every reconcile.
      // updateConsumer hits the same "queue handler missing" race
      // window as create when the worker is mid-upload, so apply
      // the same bounded retry.
      yield* queues
        .updateConsumer({
          accountId: acct,
          queueId,
          consumerId,
          scriptName: news.scriptName,
          type: "worker",
          settings: news.settings,
          deadLetterQueue: news.deadLetterQueue,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "QueueHandlerMissing",
            schedule: queueHandlerReadinessSchedule,
          }),
        );

      yield* queues.getConsumer({ accountId: acct, queueId, consumerId }).pipe(
        Effect.flatMap((fetched) =>
          toObserved(fetched)?.scriptName === news.scriptName
            ? Effect.void
            : Effect.fail("ScriptUnbound" as const),
        ),
        Effect.catchTag("ConsumerNotFound", () =>
          Effect.fail("ScriptUnbound" as const),
        ),
        Effect.retry({
          while: (e) => e === "ScriptUnbound",
          schedule: queueHandlerReadinessSchedule,
        }),
      );

      return {
        consumerId,
        queueId,
        scriptName: news.scriptName!,
        accountId: acct,
        deadLetterQueue: news.deadLetterQueue,
        settings: news.settings,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      // If the consumerId is a `dev:` ID, the resource only exists locally, so we don't need to delete it from Cloudflare.
      if (!isLiveId(output.consumerId)) return;

      yield* queues
        .deleteConsumer({
          accountId: output.accountId,
          queueId: output.queueId,
          consumerId: output.consumerId,
        })
        .pipe(Effect.catchTag("ConsumerNotFound", () => Effect.void));

      // Block until Cloudflare's worker subsystem stops claiming
      // the script as a queue consumer. Without this the
      // sibling Worker.delete races on `QueueConsumerConflict`
      // (code 10064) — `deleteConsumer` returns success on the
      // queue subsystem before the script-side view propagates.
      yield* queues
        .getConsumer({
          accountId: output.accountId,
          queueId: output.queueId,
          consumerId: output.consumerId,
        })
        .pipe(
          Effect.flatMap(() => Effect.fail("still-attached" as const)),
          Effect.catchTag("ConsumerNotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e === "still-attached",
            schedule: Schedule.max([
              Schedule.spaced("1 second"),
              Schedule.recurs(30),
            ]),
          }),
          Effect.ignore,
        );
    }),
    read: Effect.fn(function* ({ output }) {
      if (output?.consumerId) {
        const fetched = yield* queues
          .getConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
          })
          .pipe(
            Effect.catchTag("ConsumerNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (fetched) {
          return {
            consumerId: fetched.consumerId!,
            queueId: output.queueId,
            scriptName: toObserved(fetched)?.scriptName ?? output.scriptName,
            accountId: output.accountId,
            deadLetterQueue: output.deadLetterQueue,
            settings: output.settings,
          };
        }
      }
      // Fallback: a state loss can leave us without a consumerId
      // even though the consumer is still alive on Cloudflare. The
      // queue allows only one worker consumer, so finding it via
      // listConsumers is unambiguous.
      if (output?.queueId && output?.accountId) {
        const match = yield* findWorkerConsumer(
          output.accountId,
          output.queueId,
        );
        if (match) {
          return {
            consumerId: match.consumerId,
            queueId: output.queueId,
            scriptName: match.scriptName ?? output.scriptName,
            accountId: output.accountId,
            deadLetterQueue: output.deadLetterQueue,
            settings: output.settings,
          };
        }
      }
      return undefined;
    }),
  });

type ObservedConsumer = {
  consumerId: string;
  scriptName: string | undefined;
};

const toObserved = (c: {
  consumerId?: string | null;
  scriptName?: string | null;
  type?: "worker" | "http_pull" | null;
}): ObservedConsumer | undefined =>
  c.consumerId && c.type === "worker"
    ? { consumerId: c.consumerId, scriptName: c.scriptName ?? undefined }
    : undefined;

// ~60s budget — Worker reconcile uploads typically land in 2–10s,
// but a fresh container/asset deploy can stretch that.
const queueHandlerReadinessSchedule = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(30),
]);

export const ConsumerProviderLocal = () =>
  RpcProvider.effect(
    Consumer,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const localRuntimeState = yield* LocalRuntimeState;

      // Restart the locally running workerd instances (if any) for the
      // given scripts so start-time queue-consumer wiring is re-read from
      // `localRuntimeState.queueConsumers`. See `workerRestarts` on
      // {@link LocalRuntimeState}.
      const restartScripts = (scriptNames: ReadonlyArray<string>) =>
        Effect.forEach(
          scriptNames,
          (scriptName) =>
            MutableHashMap.get(
              localRuntimeState.workerRestarts,
              scriptName,
            ).pipe(
              Option.match({
                onNone: () => Effect.void,
                onSome: (restart) => restart,
              }),
            ),
          { discard: true },
        );

      return {
        list: () =>
          Effect.sync(() =>
            Array.from(MutableHashMap.values(localRuntimeState.queueConsumers)),
          ),
        diff: Effect.fn(function* ({ news, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          if (!output) return { action: "update" };
          // A real (non-`dev:`) consumerId on a local-mode row is legacy
          // damage from pre-stamping dev runs — replace so the new
          // generation mints a true local identity (delete best-effort
          // detaches the stray live consumer).
          if (isLiveId(output.consumerId)) {
            return { action: "replace" };
          }
          if (!isResolved(news)) return undefined;
          if (
            output.queueId !== news.queueId ||
            output.accountId !== accountId
          ) {
            return { action: "replace" };
          }
          if (
            JSON.stringify(output.settings ?? {}) !==
              JSON.stringify(news.settings ?? {}) ||
            output.scriptName !== news.scriptName ||
            output.deadLetterQueue !== news.deadLetterQueue
          ) {
            return { action: "update" };
          }
          // If the resource is a noop, add it to the local runtime state so it's available downstream.
          // We do it here instead of in the reconcile function so it doesn't appear as an update.
          MutableHashMap.set(
            localRuntimeState.queueConsumers,
            output.consumerId,
            output,
          );
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.consumerId) return undefined;
          return MutableHashMap.get(
            localRuntimeState.queueConsumers,
            output.consumerId,
          ).pipe(Option.getOrUndefined);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          // A LIVE queue (`Alchemy.remote()`) consumed by a LOCAL worker:
          // Cloudflare only pushes to deployed consumers, so the local
          // runtime drains the real queue via the HTTP pull API instead.
          // Observe the queue (name + existing consumers) and ensure an
          // `http_pull` consumer exists for the pull loop to lease from.
          let queueName: string | undefined;
          let pullConsumerId: string | undefined;
          if (isLiveId(news.queueId)) {
            const queue = yield* queues.getQueue({
              accountId,
              queueId: news.queueId,
            });
            queueName = queue.queueName ?? undefined;
            const existingPull = (queue.consumers ?? []).find(
              (c) => c.type === "http_pull",
            );
            if (existingPull?.consumerId) {
              pullConsumerId = existingPull.consumerId;
            } else {
              const created = yield* queues.createConsumer({
                accountId,
                queueId: news.queueId,
                type: "http_pull",
                settings: {
                  batchSize: news.settings?.batchSize,
                  maxRetries: news.settings?.maxRetries,
                  retryDelay: news.settings?.retryDelay,
                },
              });
              pullConsumerId =
                ("consumerId" in created ? created.consumerId : undefined) ??
                undefined;
            }
          }
          const consumer: Consumer["Attributes"] = {
            // Never carry a real (non-`dev:`) consumer id forward onto a
            // local row — it belongs to a live consumer this row no longer
            // manages (legacy pre-stamping damage).
            consumerId:
              output?.consumerId && !isLiveId(output.consumerId)
                ? output.consumerId
                : `dev:${crypto.randomUUID()}`,
            queueId: news.queueId,
            scriptName: news.scriptName,
            deadLetterQueue: news.deadLetterQueue,
            accountId,
            settings: news.settings,
            queueName,
            pullConsumerId,
          };
          MutableHashMap.set(
            localRuntimeState.queueConsumers,
            consumer.consumerId,
            consumer,
          );
          // A local workerd instance only reads its queue-consumer wiring
          // at start time, and this reconcile races the sibling Worker's
          // start (the Worker's `precreate` resolves `scriptName` before
          // workerd is up). Restart any already-running instance so it
          // picks up the new wiring; if the worker hasn't served yet this
          // is a no-op and its first serve observes the map we just set.
          yield* restartScripts(
            output && output.scriptName !== consumer.scriptName
              ? [output.scriptName, consumer.scriptName]
              : [consumer.scriptName],
          );
          return consumer;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(
            localRuntimeState.queueConsumers,
            output.consumerId,
          );
          yield* restartScripts([output.scriptName]);
          // Legacy local-mode rows written before providerMode stamping can
          // carry a real consumer's id — detach the live consumer too so
          // migrating the row to a true local identity doesn't strand it on
          // the queue (a stranded worker consumer blocks every future
          // createConsumer with ConsumerAlreadyExists).
          if (isLiveId(output.consumerId) && isLiveId(output.queueId)) {
            yield* queues
              .deleteConsumer({
                accountId: output.accountId,
                queueId: output.queueId,
                consumerId: output.consumerId,
              })
              .pipe(
                Effect.catchTag(
                  ["ConsumerNotFound", "QueueNotFound"],
                  () => Effect.void,
                ),
              );
          }
          // Remove the http_pull consumer this row attached to its live
          // queue. Idempotent: gone-already (or queue deleted first) is
          // success.
          if (output.pullConsumerId && isLiveId(output.queueId)) {
            yield* queues
              .deleteConsumer({
                accountId: output.accountId,
                queueId: output.queueId,
                consumerId: output.pullConsumerId,
              })
              .pipe(
                Effect.catchTag(
                  ["ConsumerNotFound", "QueueNotFound"],
                  () => Effect.void,
                ),
              );
          }
        }),
      };
    }),
  );

export const ConsumerProvider = () =>
  ProviderLayer.dual(Consumer, {
    local: () =>
      ConsumerProviderLocal().pipe(Layer.provide(localRuntimeServices())),
    live: () => ConsumerProviderLive(),
  });
