import type * as cf from "@cloudflare/workers-types";
import {
  CallbackError,
  type Callback,
  type CallbackOptions,
  type CallbackScheduleOptions,
  type CallbackFactory,
} from "alchemy/Callback";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { ensureAlarmTables, reconcileDurableObjectAlarm } from "./DurableObjectAlarmStorage.ts";
import { DurableObjectState, fromDurableObjectState } from "./DurableObjectState.ts";
import { fromDurableObjectStorage } from "./DurableObjectStorage.ts";
import { ActiveStorageTransactions } from "./DurableObjectTransactionContext.ts";

type InvocationServices = RuntimeContext | DurableObjectState | Scope.Scope;
interface RetryPolicy {
  readonly delay: number;
  readonly maxAttempts: number;
  readonly parkedDelay: number;
}
const defaultRetryPolicy: RetryPolicy = {
  delay: 30_000,
  maxAttempts: 8,
  parkedDelay: 3_600_000,
};

const recoveryDelay = (policy: RetryPolicy, attempts: number, parked: boolean) =>
  parked ? policy.parkedDelay : Math.min(policy.parkedDelay, policy.delay * 2 ** (attempts - 1));

interface RegisteredCallback {
  readonly retry: RetryPolicy;
  readonly handler: (payload: unknown) => Effect.Effect<unknown, unknown, InvocationServices>;
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
  scheduled_at: number;
  retry_at: number | null;
  attempts: number;
  parked: number;
  progress: number;
  payload: string;
};
type AlarmRef = Pick<AlarmRow, "callback" | "id" | "version">;
interface AlarmPass {
  readonly storage: cf.DurableObjectStorage;
  readonly row: AlarmRow;
  readonly justParked: boolean;
  readonly parking: AlarmRef[];
  active: boolean;
}
const CurrentAlarmPass = Context.Reference<AlarmPass | undefined>(
  "alchemy/Cloudflare/CurrentAlarmPass",
  { defaultValue: () => undefined },
);
const readAlarm = (storage: cf.DurableObjectStorage, callback: string, id: string) =>
  Effect.sync(
    () =>
      storage.sql
        .exec<AlarmRow>(
          "SELECT * FROM alchemy_alarm_callbacks WHERE callback = ? AND id = ?",
          callback,
          id,
        )
        .toArray()[0],
  );

const activePass = (storage: cf.DurableObjectStorage, callback: string) =>
  Effect.gen(function* () {
    const current = yield* CurrentAlarmPass;
    const pass = current?.storage === storage ? current : undefined;
    if (pass !== undefined && !pass.active) {
      return yield* new CallbackError({
        callback,
        message: "The alarm callback invocation has already finished",
      });
    }
    return pass;
  });

const reportParking = (pass: AlarmPass) =>
  Effect.gen(function* () {
    for (const ref of pass.parking) {
      const row = yield* readAlarm(pass.storage, ref.callback, ref.id);
      // A replacement, progress or rollback can remove tentative parking. Only
      // report committed work, without exposing its identifiers or payload.
      if (row?.version === ref.version && row.parked === 1) {
        yield* Effect.logWarning("Durable Object alarm callback parked", {
          attempts: row.attempts,
          retryAt: row.retry_at,
        }).pipe(Effect.exit);
      }
    }
  });
const registries = new WeakMap<cf.DurableObjectState, CallbackRegistry>();

/**
 * @internal Run background work handed to `waitUntil` apart from the callback
 * invocation that started it. The invocation ends first, so its schedules
 * would be rejected; here they start a fresh budget, as external schedules
 * do. Only for work whose schedules report their own progress.
 */
export const outsideAlarmPass = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentAlarmPass, undefined);

/** @internal */
export const initializeAlarmCallbacks = (state: cf.DurableObjectState) => {
  const registry: CallbackRegistry = { callbacks: new Map(), open: true };
  registries.set(state, registry);
  return () => {
    registry.open = false;
  };
};

/** @internal */
export const makeDurableObjectCallbackFactory = (raw: cf.DurableObjectState): CallbackFactory => {
  const state = fromDurableObjectState(raw);
  return (name, handler, options) => makeAlarmCallback(state, name, handler, options);
};

const makeAlarmCallback = <Payload, E, R>(
  state: DurableObjectState["Service"],
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: CallbackOptions,
): Effect.Effect<Callback<Payload>, never, RuntimeContext | Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const context = (yield* Effect.context<Exclude<R, Scope.Scope>>()).pipe(
      Context.omit(
        ActiveStorageTransactions,
        CurrentAlarmPass,
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
    const retry = yield* Effect.try({
      try: () => {
        const delay = Math.ceil(
          Duration.toMillis(options?.retry?.delay ?? defaultRetryPolicy.delay),
        );
        const maxAttempts = options?.retry?.maxAttempts ?? defaultRetryPolicy.maxAttempts;
        const parkedDelay = Math.ceil(
          Duration.toMillis(
            options?.retry?.parkedDelay ?? Math.max(defaultRetryPolicy.parkedDelay, delay),
          ),
        );
        if (
          !Number.isSafeInteger(delay) ||
          delay <= 0 ||
          !Number.isSafeInteger(maxAttempts) ||
          maxAttempts < 1 ||
          !Number.isSafeInteger(parkedDelay) ||
          parkedDelay < 3_600_000 ||
          parkedDelay < delay
        ) {
          throw new Error(
            "Retry delay must be positive, maxAttempts a positive safe integer, and parkedDelay at least one hour and the retry delay",
          );
        }
        return { delay: Math.max(1_000, delay), maxAttempts, parkedDelay };
      },
      catch: (cause) =>
        new CallbackError({
          callback: name,
          message: "Invalid alarm retry policy",
          cause,
        }),
    }).pipe(Effect.orDie);
    yield* Effect.sync(() =>
      registry.callbacks.set(name, {
        retry,
        handler: (payload) =>
          Effect.gen(function* () {
            const invocation = yield* Effect.context<InvocationServices>();
            return yield* handler(payload as Payload).pipe(
              Effect.provide(Context.merge(invocation, context) as Context.Context<R>),
            );
          }),
      }),
    );

    const raw = state.raw.storage;
    const transaction = <A, R>(effect: Effect.Effect<A, CallbackError, R>) =>
      state.storage.transaction(effect).pipe(
        Effect.mapError((cause) =>
          cause._tag === "CallbackError"
            ? cause
            : new CallbackError({
                callback: name,
                message: "Callback storage transaction failed",
                cause,
              }),
        ),
      );
    return {
      schedule: Effect.fn(function* (id: string, schedule: CallbackScheduleOptions<Payload>) {
        const now = yield* Clock.currentTimeMillis;
        const { at, payload } = yield* Effect.try({
          try: () => {
            if (!id) throw new Error("Alarm IDs must be non-empty");
            if ((schedule.at === undefined) === (schedule.after === undefined)) {
              throw new Error("Specify exactly one of at or after");
            }
            const delay =
              schedule.after === undefined ? undefined : Duration.toMillis(schedule.after);
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
              throw new Error("Alarm time must be finite and delay must be non-negative");
            }
            if (!Schema.is(Schema.Json)(schedule.payload)) {
              throw new Error("Alarm payload must be a JSON value");
            }
            if (
              schedule.progress !== undefined &&
              (!Number.isSafeInteger(schedule.progress) || schedule.progress < 0)
            ) {
              throw new Error("Alarm progress must be a nonnegative safe integer");
            }
            const payload = JSON.stringify(schedule.payload);
            if (payload === undefined) throw new Error("Alarm payload must be JSON-serializable");
            return { at, payload };
          },
          catch: (cause) =>
            new CallbackError({
              callback: name,
              message: "Invalid alarm schedule",
              cause,
            }),
        });
        yield* transaction(
          Effect.gen(function* () {
            const pass = yield* activePass(raw, name);
            yield* ensureAlarmTables(raw);
            const existing = yield* readAlarm(raw, name, id);
            const source = pass?.row;
            // Another callback's cursor counts in its own units: it never hides
            // this schedule, but a cursor that isn't past it isn't progress.
            const progress = Math.max(
              existing?.progress ?? -1,
              source?.callback === name ? source.progress : -1,
            );
            if (
              schedule.progress !== undefined &&
              (schedule.progress < progress ||
                (source === undefined && schedule.progress === progress))
            )
              return;
            const progressed =
              schedule.progress !== undefined &&
              schedule.progress > Math.max(progress, source?.progress ?? -1);
            const sourceProgressed =
              source?.callback === name &&
              source.id === id &&
              (existing?.progress ?? -1) > source.progress;
            const attempts =
              source === undefined || progressed || sourceProgressed
                ? 0
                : Math.max(source.attempts, existing?.attempts ?? 0);
            const parked =
              attempts > 0 &&
              (source?.parked === 1 || existing?.parked === 1 || attempts >= retry.maxAttempts);
            const retryAt =
              attempts === 0
                ? null
                : (yield* Clock.currentTimeMillis) + recoveryDelay(retry, attempts, parked);
            const version = yield* Effect.sync(() => crypto.randomUUID());
            yield* Effect.sync(() =>
              raw.sql.exec(
                `INSERT INTO alchemy_alarm_callbacks
             (callback, id, version, run_at, payload, scheduled_at, retry_at, attempts, parked, progress)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (callback, id) DO UPDATE SET
             version = excluded.version, run_at = excluded.run_at, payload = excluded.payload,
             scheduled_at = excluded.scheduled_at, retry_at = excluded.retry_at,
             attempts = excluded.attempts, parked = excluded.parked, progress = excluded.progress`,
                name,
                id,
                version,
                Math.max(at, retryAt ?? at),
                payload,
                at,
                retryAt,
                attempts,
                parked ? 1 : 0,
                Math.max(progress, schedule.progress ?? -1),
              ),
            );
            if (
              pass !== undefined &&
              parked &&
              (pass.justParked || (source?.parked !== 1 && existing?.parked !== 1))
            ) {
              const ref = { callback: name, id, version };
              pass.parking.push(ref);
            }
            yield* reconcileDurableObjectAlarm(raw);
          }),
        );
      }),
      cancel: Effect.fn(function* (id: string) {
        yield* transaction(
          Effect.gen(function* () {
            yield* activePass(raw, name);
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
        );
      }),
      getStatus: Effect.fn(function* (id: string) {
        return yield* transaction(
          Effect.gen(function* () {
            yield* ensureAlarmTables(raw);
            const row = yield* readAlarm(raw, name, id);
            return row === undefined
              ? undefined
              : {
                  scheduledAt: row.scheduled_at,
                  retryAt: row.retry_at ?? undefined,
                  attempts: row.attempts,
                  parked: row.parked === 1,
                  progress: row.progress < 0 ? undefined : row.progress,
                };
          }),
        );
      }),
    };
  });

/** @internal */
export const dispatchAlarmCallbacks = (state: cf.DurableObjectState, hasLegacyHandler: boolean) =>
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
        raw.sql.exec("SELECT id FROM alchemy_scheduled_events LIMIT 1").toArray(),
      );
      if (legacy.length > 0) {
        return yield* new CallbackError({
          callback: "scheduleEvent",
          message: "Pending legacy events require an alarm handler calling processScheduledEvents",
        });
      }
    }
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Effect.sync(() =>
      raw.sql
        .exec<AlarmRow>(
          `SELECT * FROM alchemy_alarm_callbacks
       WHERE run_at <= ? ORDER BY run_at, callback, id LIMIT 100`,
          now,
        )
        .toArray(),
    );
    for (const job of due) {
      const callback = registry.callbacks.get(job.callback);
      const retry = callback?.retry ?? defaultRetryPolicy;
      const claimed = yield* storage.transaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const attempts =
            job.parked === 1 ? job.attempts : Math.min(retry.maxAttempts, job.attempts + 1);
          const parked = job.parked === 1 || attempts >= retry.maxAttempts;
          const retryAt = now + recoveryDelay(retry, attempts, parked);
          const claimed = yield* Effect.sync(
            () =>
              raw.sql.exec(
                `UPDATE alchemy_alarm_callbacks
           SET run_at = MAX(scheduled_at, ?), retry_at = ?, attempts = ?, parked = ?
           WHERE callback = ? AND id = ? AND version = ?`,
                retryAt,
                retryAt,
                attempts,
                parked ? 1 : 0,
                job.callback,
                job.id,
                job.version,
              ).rowsWritten > 0,
          );
          yield* reconcileDurableObjectAlarm(raw);
          return claimed
            ? {
                ...job,
                run_at: Math.max(job.scheduled_at, retryAt),
                retry_at: retryAt,
                attempts,
                parked: parked ? 1 : 0,
              }
            : undefined;
        }),
      );
      if (!claimed) continue;
      yield* storage.sync();
      const pass: AlarmPass = {
        storage: raw,
        row: claimed,
        justParked: job.parked === 0 && claimed.parked === 1,
        parking: [],
        active: true,
      };
      if (pass.justParked) pass.parking.push(claimed);
      const result = yield* Effect.gen(function* () {
        if (!callback) {
          return yield* new CallbackError({
            callback: job.callback,
            message: "No handler is registered for a pending alarm",
          });
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
      }).pipe(
        Effect.provideService(CurrentAlarmPass, pass),
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            pass.active = false;
          }),
        ),
        Effect.exit,
      );
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
        yield* storage.transaction(
          Effect.gen(function* () {
            // The pre-handler wake survives crashes. A completed failure starts
            // its backoff here, even when the handler outlasted that recovery wake.
            const retryAt =
              (yield* Clock.currentTimeMillis) +
              recoveryDelay(retry, claimed.attempts, claimed.parked === 1);
            yield* Effect.sync(() =>
              raw.sql.exec(
                `UPDATE alchemy_alarm_callbacks SET run_at = MAX(scheduled_at, ?), retry_at = ?
             WHERE callback = ? AND id = ? AND version = ?`,
                retryAt,
                retryAt,
                job.callback,
                job.id,
                job.version,
              ),
            );
            yield* reconcileDurableObjectAlarm(raw);
          }),
        );
        yield* Effect.logError("Durable Object alarm callback failed", result.cause);
      } else {
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
      yield* reportParking(pass);
    }
    yield* storage.transaction(reconcileDurableObjectAlarm(raw));
  });
