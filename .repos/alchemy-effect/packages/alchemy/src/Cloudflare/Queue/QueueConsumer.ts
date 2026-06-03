import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

// ~60s budget — Worker reconcile uploads typically land in 2–10s,
// but a fresh container/asset deploy can stretch that.
const queueHandlerReadinessSchedule = Schedule.spaced("2 seconds").pipe(
  Schedule.both(Schedule.recurs(30)),
);

export type QueueConsumerProps = {
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
  settings?: {
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
  };
};

export type QueueConsumer = Resource<
  "Cloudflare.QueueConsumer",
  QueueConsumerProps,
  {
    consumerId: string;
    queueId: string;
    scriptName: string;
    accountId: string;
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
 * already has a Worker consumer pointing at a different script, the
 * deploy fails with a clear error rather than silently adopting it.
 *
 * @section Registering a Consumer
 * @example Basic consumer
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue");
 * const worker = yield* Cloudflare.Worker("Worker", { ... });
 *
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 * });
 * ```
 *
 * @example Consumer with settings
 * ```typescript
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 *   settings: {
 *     batchSize: 50,
 *     maxRetries: 5,
 *     maxWaitTimeMs: 10000,
 *   },
 * });
 * ```
 */
export const QueueConsumer = Resource<QueueConsumer>(
  "Cloudflare.QueueConsumer",
);

type ObservedConsumer = {
  consumerId: string;
  script: string | undefined;
};

const toObserved = (c: {
  consumerId?: string | null;
  scriptName?: string | null;
  type?: "worker" | "http_pull" | null;
}): ObservedConsumer | undefined =>
  c.consumerId && c.type === "worker"
    ? { consumerId: c.consumerId, script: c.scriptName ?? undefined }
    : undefined;

export const QueueConsumerProvider = () =>
  Provider.effect(
    QueueConsumer,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createConsumer = yield* queues.createConsumer;
      const getConsumer = yield* queues.getConsumer;
      const updateConsumer = yield* queues.updateConsumer;
      const deleteConsumer = yield* queues.deleteConsumer;

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
        );

      return {
        stables: ["consumerId", "accountId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
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
          const acct = output?.accountId ?? accountId;
          const queueId =
            output?.queueId ?? (news.queueId as unknown as string);

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
          if (output?.consumerId) {
            const fetched = yield* getConsumer({
              accountId: acct,
              queueId,
              consumerId: output.consumerId,
            }).pipe(
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
            observed.script !== undefined &&
            observed.script !== news.scriptName
          ) {
            yield* deleteConsumer({
              accountId: acct,
              queueId,
              consumerId: observed.consumerId,
            }).pipe(Effect.catchTag("ConsumerNotFound", () => Effect.void));
            // Wait for Cloudflare's worker subsystem to drop its
            // claim on the old script so createConsumer below
            // doesn't race the queue↔script propagation lag.
            yield* getConsumer({
              accountId: acct,
              queueId,
              consumerId: observed.consumerId,
            }).pipe(
              Effect.flatMap(() => Effect.fail("still-attached" as const)),
              Effect.catchTag("ConsumerNotFound", () => Effect.void),
              Effect.retry({
                while: (e) => e === "still-attached",
                schedule: Schedule.spaced("1 second").pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
              Effect.ignore,
            );
            observed = undefined;
            owned = false;
          }

          // Refuse to take over a foreign consumer on the state-loss
          // path. With `owned=false` we found this via the list scan
          // and the script mismatch means it belongs to another
          // resource or was created out-of-band — silent adoption
          // would clobber that.
          if (
            observed &&
            !owned &&
            observed.script !== undefined &&
            observed.script !== news.scriptName
          ) {
            return yield* Effect.die(
              `Cloudflare queue "${queueId}" already has a worker ` +
                `consumer for script "${observed.script}", but this ` +
                `resource is configured for "${news.scriptName}" and ` +
                `local state for the consumer was missing. Each queue ` +
                `can have only one worker consumer — delete the ` +
                `existing one, update scriptName to match, or restore ` +
                `the consumer's state entry before redeploying.`,
            );
          }

          // Ensure — create if missing. ConsumerAlreadyExists is the
          // race signal: another reconcile or peer beat us to it.
          // Re-run the lookup; the paginated stream tolerates the
          // single-page eventual-consistency window the previous
          // implementation missed.
          let consumerId: string;
          if (!observed) {
            const created = yield* createConsumer({
              accountId: acct,
              queueId,
              scriptName: news.scriptName,
              type: "worker",
              deadLetterQueue: news.deadLetterQueue,
              settings: news.settings,
            }).pipe(
              // The sibling Worker resource pre-creates a placeholder
              // script with no `queue` handler; Cloudflare returns
              // code 11001 until the real reconcile uploads the
              // handler. Retry until the upload propagates (capped),
              // then surface a real failure if it never does.
              Effect.tapError((e) =>
                e._tag === "QueueHandlerMissing"
                  ? Effect.logDebug(
                      `QueueConsumer create: worker ` +
                        `"${news.scriptName}" has no queue handler ` +
                        `yet (code 11001), retrying`,
                    )
                  : Effect.void,
              ),
              Effect.retry({
                while: (e) => e._tag === "QueueHandlerMissing",
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
                    match.script !== undefined &&
                    match.script !== news.scriptName
                  ) {
                    return yield* Effect.die(
                      `Cloudflare queue "${queueId}" already has a ` +
                        `worker consumer for script "${match.script}", ` +
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
          yield* updateConsumer({
            accountId: acct,
            queueId,
            consumerId,
            scriptName: news.scriptName,
            type: "worker",
            settings: news.settings,
            deadLetterQueue: news.deadLetterQueue,
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "QueueHandlerMissing",
              schedule: queueHandlerReadinessSchedule,
            }),
          );

          yield* getConsumer({ accountId: acct, queueId, consumerId }).pipe(
            Effect.flatMap((fetched) =>
              toObserved(fetched)?.script === news.scriptName
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
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
          }).pipe(Effect.catchTag("ConsumerNotFound", () => Effect.void));

          // Block until Cloudflare's worker subsystem stops claiming
          // the script as a queue consumer. Without this the
          // sibling Worker.delete races on `QueueConsumerConflict`
          // (code 10064) — `deleteConsumer` returns success on the
          // queue subsystem before the script-side view propagates.
          yield* getConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
          }).pipe(
            Effect.flatMap(() => Effect.fail("still-attached" as const)),
            Effect.catchTag("ConsumerNotFound", () => Effect.void),
            Effect.retry({
              while: (e) => e === "still-attached",
              schedule: Schedule.spaced("1 second").pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
            }),
            Effect.ignore,
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.consumerId) {
            const fetched = yield* getConsumer({
              accountId: output.accountId,
              queueId: output.queueId,
              consumerId: output.consumerId,
            }).pipe(
              Effect.catchTag("ConsumerNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            if (fetched) {
              return {
                consumerId: fetched.consumerId!,
                queueId: output.queueId,
                scriptName:
                  ("scriptName" in fetched &&
                  typeof fetched.scriptName === "string"
                    ? fetched.scriptName
                    : output.scriptName) ?? output.scriptName,
                accountId: output.accountId,
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
                scriptName: match.script ?? output.scriptName,
                accountId: output.accountId,
              };
            }
          }
          return undefined;
        }),
      };
    }),
  );
