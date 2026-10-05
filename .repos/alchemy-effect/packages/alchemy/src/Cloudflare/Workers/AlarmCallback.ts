import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as Logger from "effect/Logger";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  ensureAlarmTables,
  reconcileDurableObjectAlarm,
} from "./DurableObjectAlarmStorage.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { fromDurableObjectStorage } from "./DurableObjectStorage.ts";
import { ActiveStorageTransactions } from "./DurableObjectTransactionContext.ts";
import {
  CallbackError,
  type Callback,
  type CallbackOptions,
  type CallbackScheduleOptions,
  type CallbackFactory,
} from "../../Callback.ts";

type InvocationServices = RuntimeContext | DurableObjectState | Scope.Scope;
interface RegisteredCallback {
  readonly retryDelay: number;
  readonly handler: (
    payload: unknown,
  ) => Effect.Effect<unknown, unknown, InvocationServices>;
}
interface CallbackRegistry {
  readonly callbacks: Map<string, RegisteredCallback>;
  open: boolean;
}
type AlarmRow = {
  callback: string;
  id: string;
  version: string;
  run_at: number;
  payload: string;
};
const registries = new WeakMap<cf.DurableObjectState, CallbackRegistry>();

/** @internal */
export const initializeAlarmCallbacks = (state: cf.DurableObjectState) => {
  const registry: CallbackRegistry = { callbacks: new Map(), open: true };
  registries.set(state, registry);
  return () => {
    registry.open = false;
  };
};

/** @internal */
export const makeDurableObjectCallbackFactory = (
  raw: cf.DurableObjectState,
): CallbackFactory => {
  const state = fromDurableObjectState(raw);
  return (name, handler, options) =>
    makeAlarmCallback(state, name, handler, options);
};

const makeAlarmCallback = <Payload, E, R>(
  state: DurableObjectState["Service"],
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: CallbackOptions,
): Effect.Effect<
  Callback<Payload>,
  never,
  RuntimeContext | Exclude<R, Scope.Scope>
> =>
  Effect.gen(function* () {
    const context = (yield* Effect.context<Exclude<R, Scope.Scope>>()).pipe(
      Context.omit(
        ActiveStorageTransactions,
        DurableObjectState,
        RuntimeContext,
        Scope.Scope,
        Tracer.ParentSpan,
        Tracer.Tracer,
        Logger.CurrentLoggers,
      ),
    );
    const registry = registries.get(state.raw);
    if (!registry?.open || !name || registry.callbacks.has(name)) {
      return yield* Effect.die(
        new CallbackError({
          callback: name,
          message: !registry?.open
            ? "Alarm callbacks must be registered during Durable Object instance initialization"
            : "Alarm callback names must be non-empty and unique within an instance",
        }),
      );
    }
    const retryDelay = yield* Effect.sync(() =>
      Duration.toMillis(options?.retry?.delay ?? "30 seconds"),
    );
    if (!Number.isFinite(retryDelay) || retryDelay <= 0) {
      return yield* Effect.die(
        new CallbackError({
          callback: name,
          message: "Alarm retry delay must be finite and positive",
        }),
      );
    }
    yield* Effect.sync(() =>
      registry.callbacks.set(name, {
        retryDelay,
        handler: (payload) =>
          Effect.gen(function* () {
            const invocation = yield* Effect.context<InvocationServices>();
            return yield* handler(payload as Payload).pipe(
              Effect.provide(
                Context.merge(invocation, context) as Context.Context<R>,
              ),
            );
          }),
      }),
    );

    const raw = state.raw.storage;
    return {
      schedule: Effect.fn(function* (
        id: string,
        schedule: CallbackScheduleOptions<Payload>,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const { at, payload } = yield* Effect.try({
          try: () => {
            if (!id) throw new Error("Alarm IDs must be non-empty");
            if (
              (schedule.at === undefined) ===
              (schedule.after === undefined)
            ) {
              throw new Error("Specify exactly one of at or after");
            }
            const delay =
              schedule.after === undefined
                ? undefined
                : Duration.toMillis(schedule.after);
            const at =
              schedule.at === undefined
                ? now + delay!
                : schedule.at instanceof Date
                  ? schedule.at.getTime()
                  : schedule.at;
            if (
              !Number.isFinite(at) ||
              at <= 0 ||
              (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
            ) {
              throw new Error(
                "Alarm time must be finite and delay must be non-negative",
              );
            }
            if (!Schema.is(Schema.Json)(schedule.payload)) {
              throw new Error("Alarm payload must be a JSON value");
            }
            const payload = JSON.stringify(schedule.payload);
            if (payload === undefined)
              throw new Error("Alarm payload must be JSON-serializable");
            return { at, payload };
          },
          catch: (cause) =>
            new CallbackError({
              callback: name,
              message: "Invalid alarm schedule",
              cause,
            }),
        });
        const version = yield* Effect.sync(() => crypto.randomUUID());
        yield* state.storage
          .transaction(
            Effect.gen(function* () {
              yield* ensureAlarmTables(raw);
              yield* Effect.sync(() =>
                raw.sql.exec(
                  `INSERT INTO alchemy_alarm_callbacks (callback, id, version, run_at, payload)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (callback, id) DO UPDATE SET
             version = excluded.version, run_at = excluded.run_at, payload = excluded.payload`,
                  name,
                  id,
                  version,
                  at,
                  payload,
                ),
              );
              yield* reconcileDurableObjectAlarm(raw);
            }),
          )
          .pipe(
            Effect.catchTag("DurableObjectStorageError", (cause) =>
              Effect.fail(
                new CallbackError({
                  callback: name,
                  message: "Callback storage transaction failed",
                  cause,
                }),
              ),
            ),
          );
      }),
      cancel: Effect.fn(function* (id: string) {
        yield* state.storage
          .transaction(
            Effect.gen(function* () {
              yield* ensureAlarmTables(raw);
              yield* Effect.sync(() =>
                raw.sql.exec(
                  "DELETE FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ?",
                  name,
                  id,
                ),
              );
              yield* reconcileDurableObjectAlarm(raw);
            }),
          )
          .pipe(
            Effect.catchTag("DurableObjectStorageError", (cause) =>
              Effect.fail(
                new CallbackError({
                  callback: name,
                  message: "Callback storage transaction failed",
                  cause,
                }),
              ),
            ),
          );
      }),
    };
  });

/** @internal */
export const dispatchAlarmCallbacks = (
  state: cf.DurableObjectState,
  hasLegacyHandler: boolean,
) =>
  Effect.gen(function* () {
    const registry = registries.get(state);
    if (!registry) return;
    const raw = state.storage;
    if (registry.callbacks.size === 0) {
      const hasJobs = yield* Effect.sync(
        () =>
          raw.sql
            ?.exec(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('alchemy_alarm_callbacks', 'alchemy_alarm_schema', 'alchemy_scheduled_events')",
            )
            .toArray().length > 0,
      );
      if (!hasJobs) return;
    }
    const storage = fromDurableObjectStorage(raw);
    yield* ensureAlarmTables(raw);
    if (!hasLegacyHandler) {
      const legacy = yield* Effect.sync(() =>
        raw.sql
          .exec("SELECT id FROM alchemy_scheduled_events LIMIT 1")
          .toArray(),
      );
      if (legacy.length > 0) {
        return yield* Effect.fail(
          new CallbackError({
            callback: "scheduleEvent",
            message:
              "Pending legacy events require an alarm handler calling processScheduledEvents",
          }),
        );
      }
    }
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Effect.sync(() =>
      raw.sql
        .exec<AlarmRow>(
          `SELECT callback, id, version, run_at, payload FROM alchemy_alarm_callbacks
       WHERE run_at <= ? ORDER BY run_at, callback, id LIMIT 100`,
          now,
        )
        .toArray(),
    );
    for (const job of due) {
      const callback = registry.callbacks.get(job.callback);
      const claimed = yield* storage.transaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const claimed = yield* Effect.sync(
            () =>
              raw.sql.exec(
                `UPDATE alchemy_alarm_callbacks SET run_at = ?
           WHERE callback = ? AND id = ? AND version = ?`,
                now + (callback?.retryDelay ?? 30_000),
                job.callback,
                job.id,
                job.version,
              ).rowsWritten > 0,
          );
          yield* reconcileDurableObjectAlarm(raw);
          return claimed;
        }),
      );
      if (!claimed) continue;
      yield* storage.sync();
      const result = yield* Effect.gen(function* () {
        if (!callback) {
          return yield* Effect.fail(
            new CallbackError({
              callback: job.callback,
              message: "No handler is registered for a pending alarm",
            }),
          );
        }
        const payload = yield* Effect.try({
          try: () => JSON.parse(job.payload),
          catch: (cause) =>
            new CallbackError({
              callback: job.callback,
              message: "Invalid persisted alarm payload",
              cause,
            }),
        });
        yield* callback.handler(payload);
      }).pipe(Effect.scoped, Effect.exit);
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        yield* Effect.logError(
          "Durable Object alarm callback failed",
          result.cause,
        );
        continue;
      }
      yield* storage.transaction(
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            raw.sql.exec(
              "DELETE FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ? AND version = ?",
              job.callback,
              job.id,
              job.version,
            ),
          );
          yield* reconcileDurableObjectAlarm(raw);
        }),
      );
    }
    yield* storage.transaction(reconcileDurableObjectAlarm(raw));
  });
