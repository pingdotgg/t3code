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
  /** Recovery delay after an unsuccessful or interrupted delivery. Defaults to 30 seconds. */
  readonly retry?: {
    /** Must be a finite, positive duration. */
    readonly delay: Duration.Input;
  };
}

export type CallbackScheduleOptions<Payload> = {
  /** JSON-serializable data delivered to the callback. */
  readonly payload: Payload;
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

export interface Callback<Payload> {
  /** Schedule or replace a pending job identified by this callback's name and the supplied ID. */
  readonly schedule: (
    id: string,
    options: CallbackScheduleOptions<Payload>,
  ) => Effect.Effect<void, CallbackError, RuntimeContext>;
  /** Cancel a pending job. Cancelling an absent ID succeeds; an already-running handler is not interrupted. */
  readonly cancel: (
    id: string,
  ) => Effect.Effect<void, CallbackError, RuntimeContext>;
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
) => Effect.Effect<
  Callback<Payload>,
  never,
  RuntimeContext | Exclude<R, Scope.Scope>
>;

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
): Effect.Effect<
  Callback<Payload>,
  never,
  RuntimeContext | Exclude<R, Scope.Scope>
> =>
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
