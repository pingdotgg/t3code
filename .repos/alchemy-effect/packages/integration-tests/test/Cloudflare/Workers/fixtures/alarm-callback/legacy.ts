import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export interface ScheduledRow {
  readonly id: string;
  readonly run_at: number;
  readonly repeat_ms: number | null;
  readonly payload: string;
  readonly [column: string]: string | number | null;
}

export interface ScheduledSnapshot {
  readonly rows: ScheduledRow[];
  readonly alarm: number | null;
  readonly marker: string | null;
  readonly callbackTablePresent: boolean;
}

export interface ScheduledRegressionResult {
  readonly now: number;
  readonly before: ScheduledSnapshot;
  readonly after: ScheduledSnapshot;
  readonly fired: Array<{ id: string; runAt: number; repeatMs: number | null; payload: unknown }>;
  readonly failure: string | null;
  readonly expected: Array<{ id: string; value: string }>;
  readonly actual: Array<{ id: string; value: string }>;
}

export type ScheduledScenario =
  | "mixed"
  | "oneshot"
  | "repeat"
  | "snapshot"
  | "empty"
  | "future"
  | "arithmetic"
  | "malformed"
  | "sql-failure";

export class LegacyAlarmObject extends Cloudflare.DurableObject<LegacyAlarmObject>()(
  "LegacyAlarmObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const registered = yield* Alchemy.makeCallback(
        "registered",
        Effect.fn(function* (payload: { value: string }) {
          yield* state.storage.put("registered", payload.value);
        }),
      );
      return {
        scheduledRegression: (scenario: ScheduledScenario, count: number) =>
          Effect.gen(function* () {
            // Fix only the scheduler's wall-time input. Every SQL statement,
            // transaction, KV access and alarm operation uses the real DO.
            // Future dates keep native alarms from racing the assertions.
            const now = Date.UTC(2100, 0, 1) + 1;
            const clock = yield* Clock.Clock;
            const schedulerClock: Clock.Clock = {
              currentTimeMillisUnsafe: () => now,
              currentTimeMillis: Effect.succeed(now),
              currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
              currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) => clock.sleep(duration),
            };
            const storage = state.storage;
            const snapshot = Effect.gen(function* () {
              const rows = yield* (yield* storage.sql.exec<ScheduledRow>(
                "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
              )).toArray();
              const callbackTables = yield* (yield* storage.sql.exec<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alchemy_alarm_callbacks'",
              )).toArray();
              return {
                rows,
                alarm: yield* storage.getAlarm(),
                marker: (yield* storage.get<string>("scheduler-marker")) ?? null,
                callbackTablePresent: callbackTables.length === 1,
              } satisfies ScheduledSnapshot;
            });
            const reset = Effect.gen(function* () {
              yield* storage.sql.exec("DELETE FROM alchemy_scheduled_events");
              yield* storage.sql.exec("DROP TABLE IF EXISTS scheduler_expected");
              yield* storage.delete("scheduler-marker");
              yield* storage.deleteAlarm();
            });
            const schedule = (id: string, at: number, repeat?: number) =>
              Cloudflare.scheduleEvent(id, new Date(at), { id }, repeat);
            return yield* Effect.gen(function* () {
              // Initialize through the public scheduler before using SQL to
              // inspect its persisted state or introduce a corruption fault.
              yield* Cloudflare.listEvents;
              yield* reset;
              yield* storage.transaction(
                Effect.gen(function* () {
                  if (["mixed", "oneshot", "repeat"].includes(scenario)) {
                    if (count !== 100 && count !== 1_000) {
                      return yield* Effect.die(
                        new Error("Scheduled batch count must be 100 or 1000"),
                      );
                    }
                    for (let i = 0; i < count; i++) {
                      yield* schedule(
                        `event-${String(i).padStart(4, "0")}`,
                        now - count + i,
                        scenario === "repeat" || (scenario === "mixed" && i % 2 === 1)
                          ? 86_400_000
                          : undefined,
                      );
                    }
                  } else if (scenario === "snapshot") {
                    yield* schedule("future", now + 10);
                    yield* schedule("fractional", now - 2, 0.25);
                    yield* schedule("one-shot", now - 5);
                    yield* schedule("negative", now - 3, -3);
                    yield* schedule("zero", now, 0);
                  } else if (scenario === "future") {
                    yield* schedule("future", now + 60_000, 5);
                  } else if (scenario === "arithmetic") {
                    const repeats = [
                      0,
                      -1,
                      0.25,
                      -0.25,
                      Number.MAX_SAFE_INTEGER,
                      Number.MIN_SAFE_INTEGER,
                      2 ** 53 + 2,
                      -(2 ** 53 + 2),
                      1.5e100,
                    ];
                    for (let i = 0; i < repeats.length; i++) {
                      yield* schedule(String(i), now - 1, repeats[i]);
                    }
                  } else if (scenario === "malformed" || scenario === "sql-failure") {
                    yield* schedule("first", now - 3);
                    yield* schedule("repeat", now - 2, 10);
                    yield* schedule("last", now - 1);
                  }
                }),
              );
              if (scenario === "malformed") {
                yield* storage.sql.exec(
                  "UPDATE alchemy_scheduled_events SET payload = ? WHERE id = ?",
                  "{",
                  "repeat",
                );
              }
              if (["malformed", "sql-failure", "empty", "future"].includes(scenario)) {
                yield* storage.setAlarm(now + 123);
              }
              const before = yield* snapshot;
              if (scenario === "arithmetic") {
                // Store the former JS calculation through the same native
                // SQLite affinity, then compare exact SQL representations.
                yield* storage.sql.exec(
                  "CREATE TABLE scheduler_expected (id TEXT PRIMARY KEY, run_at INTEGER)",
                );
                for (const row of before.rows) {
                  yield* storage.sql.exec(
                    "INSERT INTO scheduler_expected (id, run_at) VALUES (?, ?)",
                    row.id,
                    now + row.repeat_ms!,
                  );
                }
              }
              const outcome = yield* (
                scenario === "malformed" || scenario === "sql-failure"
                  ? storage.transaction(
                      Effect.gen(function* () {
                        yield* storage.put("scheduler-marker", "uncommitted");
                        if (scenario === "sql-failure") {
                          // Real reconciliation failure after due-row mutations;
                          // native rollback must restore this table too.
                          yield* storage.sql.exec("DROP TABLE alchemy_alarm_callbacks");
                        }
                        return yield* Cloudflare.processScheduledEvents;
                      }),
                    )
                  : Cloudflare.processScheduledEvents
              ).pipe(Effect.exit);
              if (
                Exit.isFailure(outcome) &&
                scenario !== "malformed" &&
                scenario !== "sql-failure"
              ) {
                return yield* Effect.failCause(outcome.cause);
              }
              const representation = (table: string) =>
                Effect.flatMap(
                  storage.sql.exec<{ id: string; value: string }>(
                    `SELECT id, quote(run_at) AS value FROM ${table} ORDER BY id`,
                  ),
                  (cursor) => cursor.toArray(),
                );
              return {
                now,
                before,
                after: yield* snapshot,
                fired: Exit.isSuccess(outcome)
                  ? outcome.value.map((event) => ({
                      id: event.id,
                      runAt: event.runAt.getTime(),
                      repeatMs: event.repeatMs ?? null,
                      payload: event.payload,
                    }))
                  : [],
                failure: Exit.isFailure(outcome) ? String(Cause.squash(outcome.cause)) : null,
                expected:
                  scenario === "arithmetic" ? yield* representation("scheduler_expected") : [],
                actual:
                  scenario === "arithmetic"
                    ? yield* representation("alchemy_scheduled_events")
                    : [],
              } satisfies ScheduledRegressionResult;
            }).pipe(
              Effect.provideService(Cloudflare.DurableObjectState, state),
              Effect.provideService(Clock.Clock, schedulerClock),
              Effect.ensuring(reset),
            );
          }),
        start: Effect.fn(
          function* () {
            const at = yield* Effect.sync(() => new Date(Date.now() + 1_500));
            yield* state.storage.transaction(
              Effect.gen(function* () {
                yield* registered.schedule("shared-id", {
                  at,
                  payload: { value: "registered" },
                });
                yield* Cloudflare.scheduleEvent("shared-id", at, {
                  value: "legacy",
                });
                yield* Cloudflare.scheduleEvent("cancelled", at, {
                  value: "cancelled",
                });
                yield* Cloudflare.cancelEvent("cancelled");
              }),
            );
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
        alarm: Effect.fn(
          function* () {
            const events = yield* Cloudflare.processScheduledEvents;
            const fired = (yield* state.storage.get<Cloudflare.ScheduledEvent[]>("legacy")) ?? [];
            yield* state.storage.put("legacy", [...fired, ...events]);
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
        snapshot: Effect.fn(
          function* () {
            return {
              registered: (yield* state.storage.get<string>("registered")) ?? null,
              legacy: (yield* state.storage.get<Cloudflare.ScheduledEvent[]>("legacy")) ?? [],
              pending: yield* Cloudflare.listEvents,
              alarm: yield* state.storage.getAlarm(),
            };
          },
          Effect.provideService(Cloudflare.DurableObjectState, state),
        ),
      };
    });
  }),
) {}
