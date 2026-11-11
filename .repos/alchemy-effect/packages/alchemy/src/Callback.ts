import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { RuntimeContext } from "./RuntimeContext.ts";

/** A durable callback could not be registered, scheduled, cancelled, or dispatched. */
export class CallbackError extends Data.TaggedError("CallbackError")<{
  readonly callback: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CallbackOptions {
  /** Bounded backoff for unsuccessful deliveries and self-rescheduling without progress. */
  readonly retry?: {
    /** Initial delay. Defaults to 30 seconds; positive durations below one second use one second. */
    readonly delay?: Duration.Input;
    /** Attempts without progress before parking. Must be a positive safe integer. Defaults to eight. */
    readonly maxAttempts?: number;
    /** Recovery interval for parked work. Must be at least one hour and the initial delay. Defaults to the greater of those two values. */
    readonly parkedDelay?: Duration.Input;
  };
}

export type CallbackScheduleOptions<Payload> = {
  /** JSON-serializable data delivered to the callback. */
  readonly payload: Payload;
  /**
   * Committed source version or sequence, as a nonnegative safe integer.
   * A strictly increasing value resets the retry budget. Replayed external
   * schedules cannot replace newer work. Commit progress and scheduling in the
   * same storage transaction; changing IDs, payloads, or deadlines is not progress.
   */
  readonly progress?: number;
} & (
  | {
      /** Absolute delivery time, as a Date or positive milliseconds since the Unix epoch. */
      readonly at: Date | number;
      readonly after?: never;
    }
  | {
      /** Minimum delay before delivery. Zero schedules the callback as soon as possible. */
      readonly after: Duration.Input;
      readonly at?: never;
    }
);

/** Durable scheduling state, available without decoding the job's payload. */
export interface CallbackStatus {
  /** Requested delivery time in milliseconds since the Unix epoch; preserved across retries. */
  readonly scheduledAt: number;
  /** Earliest recovery time in milliseconds since the Unix epoch, if an attempt has started. */
  readonly retryAt: number | undefined;
  /** Attempts started without reported progress, capped when the job is parked. */
  readonly attempts: number;
  /** Whether the job is retained for recovery at the parked interval. */
  readonly parked: boolean;
  /** Latest committed source cursor supplied when scheduling, if any. */
  readonly progress: number | undefined;
}

export interface Callback<Payload> {
  /** Schedule or replace a pending job identified by this callback's name and the supplied ID. */
  readonly schedule: (
    id: string,
    options: CallbackScheduleOptions<Payload>,
  ) => Effect.Effect<void, CallbackError, RuntimeContext>;
  /** Cancel a pending job. Cancelling an absent ID succeeds; an already-running handler is not interrupted. */
  readonly cancel: (id: string) => Effect.Effect<void, CallbackError, RuntimeContext>;
  /** Inspect a pending job. Returns undefined after successful completion or cancellation. */
  readonly getStatus: (
    id: string,
  ) => Effect.Effect<CallbackStatus | undefined, CallbackError, RuntimeContext>;
}

/**
 * Host-provided durable callback registration and scheduling.
 *
 * Implementations scope callback names and job IDs to a durable owner, persist
 * jobs and recovery wakes, and acknowledge successful handlers without deleting
 * same-ID replacements. Each invocation supplies a fresh Scope. Scheduling joins
 * a storage transaction only when the host supports that transaction boundary.
 */
export type CallbackFactory = <Payload, E, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: CallbackOptions,
) => Effect.Effect<Callback<Payload>, never, RuntimeContext | Exclude<R, Scope.Scope>>;

/**
 * Register a durable callback with the current host.
 *
 * Cloudflare Durable Objects supply callback registration on their per-instance
 * RuntimeContext. Register handlers in their inner Effect. Other hosts must
 * implement RuntimeContext.makeCallback; unsupported hosts reject registration.
 * Delivery is at least once: external writes must be idempotent. This API does
 * not make unrelated external operations atomic.
 *
 * ### Registering and Scheduling a Callback
 * **Example:** Schedule typed work from a Durable Object instance
 * ```typescript
 * return Effect.gen(function* () {
 *   const onArchive = yield* Alchemy.makeCallback(
 *     "archive",
 *     Effect.fn(function* (payload: { key: string; body: string }) {
 *       yield* archive.put(payload.key, payload.body);
 *     }),
 *   );
 *   return {
 *     save: Effect.fn(function* (id: string, body: string) {
 *       yield* state.storage.transaction(
 *         Effect.gen(function* () {
 *           yield* state.storage.put(id, body);
 *           yield* onArchive.schedule(id, {
 *             after: "30 seconds",
 *             payload: { key: id, body },
 *           });
 *         }),
 *       );
 *     }),
 *   };
 * });
 * ```
 *
 * ### Cancelling or Replacing a Job
 * **Example:** Use a stable ID within a callback
 * ```typescript
 * yield* onArchive.schedule("revision-42", {
 *   at: new Date("2026-10-01T09:00:00Z"),
 *   payload: { key: "42.txt", body: "hello" },
 * });
 * yield* onArchive.cancel("revision-42");
 * ```
 *
 * ### Inspecting and Recovering Work
 * **Example:** Resume a parked job from an incoming recovery request
 * ```typescript
 * const status = yield* onArchive.getStatus("revision-42");
 * if (status?.parked) {
 *   yield* onArchive.schedule("revision-42", {
 *     after: 0,
 *     payload: { key: "42.txt", body: "hello" },
 *   });
 * }
 * ```
 *
 * Cloudflare persists an exponential retry budget before each attempt. The
 * default initial delay is 30 seconds, with a one-second minimum. After eight
 * attempts without progress, jobs remain stored and recover hourly. Configure
 * `retry.delay`, `retry.maxAttempts`, and `retry.parkedDelay` when registering.
 * Status preserves the requested `scheduledAt` separately from `retryAt`.
 *
 * Scheduling inside a callback inherits its budget, including when cancelling
 * or changing IDs. Supply a strictly increasing `progress` cursor alongside
 * committed application state to reset it. An external schedule without a
 * cursor starts a fresh budget; stale external cursors leave existing work
 * unchanged. Detached callback fibers cannot schedule or cancel after the
 * invocation ends. Successful completion and cancellation remove the job.
 *
 * Callback names identify persisted jobs; retain handlers for old names while
 * jobs are pending. Payloads must be JSON values compatible with pending jobs
 * from earlier deployments; TypeScript types do not perform runtime decoding.
 * Cloudflare commits scheduling alongside SQLite, KV, and native alarm writes
 * inside the same Durable Object's storage transaction. Automatic recovery from
 * instance termination relies on Cloudflare's native alarm retries. Calling
 * `state.abort` with `{ retryAlarm: false }` removes that recovery guarantee:
 * pending jobs remain stored, but may need an explicitly rearmed native alarm.
 * Other implementations must document their own transaction integration.
 */
export const makeCallback = <Payload, E, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: CallbackOptions,
): Effect.Effect<Callback<Payload>, never, RuntimeContext | Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const context = yield* RuntimeContext;
    if (!context.makeCallback) {
      return yield* Effect.die(
        new CallbackError({
          callback: name,
          message: `Durable callbacks are not supported by ${context.Type}`,
        }),
      );
    }
    return yield* context.makeCallback(name, handler, options);
  });
