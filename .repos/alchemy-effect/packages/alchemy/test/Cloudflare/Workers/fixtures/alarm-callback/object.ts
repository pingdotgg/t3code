import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";

class TransactionMarker extends Context.Service<
  TransactionMarker,
  { value: string }
>()("alarm-callback/TransactionMarker") {}

class Rollback extends Data.TaggedError("Rollback")<{ value: string }> {}
class RetryArchive extends Data.TaggedError("RetryArchive")<{}> {}

export interface Delivery {
  callback: string;
  value: string;
  application: string | null;
  boots: number;
}

export interface Attempt {
  now: number;
  recovery: number | null;
  boots: number;
}

export interface Snapshot {
  id: string;
  boots: number;
  deliveries: Delivery[];
  attempts: Attempt[];
  application: string | null;
  cleanupWrite: string | null;
  rows: { value: string }[];
  alarm: number | null;
  pendingJobs: {
    callback: string;
    id: string;
    run_at: number;
    version: string;
  }[];
}

export interface RegistrationResult {
  failure: {
    tag: "CallbackError";
    callback: string;
    message: string;
  } | null;
  snapshot: Snapshot;
}

export interface RollbackResult {
  failure: string;
  cleanupWaited: boolean;
  alarmBefore: number | null;
  alarmAfter: number | null;
  snapshot: Snapshot;
}

export interface SiblingTransactionResult {
  failure: string;
  siblingAcknowledged: boolean;
  siblingFailure: {
    tag: "DurableObjectStorageError";
    operation: string;
    message: string;
  } | null;
  siblingValue: string | null;
  snapshot: Snapshot;
}

export interface BookkeepingCounts {
  schemaChecks: number;
  reconciliations: number;
  setAlarm: number;
  deleteAlarm: number;
}

export interface BatchResult {
  counts: BookkeepingCounts;
  snapshot: Snapshot;
}

export interface FailedBatchResult {
  failure: string | null;
  rolledBack: BatchResult;
  recovered: BatchResult;
}

export interface AlarmObservationResult {
  at: number;
  observations: (number | null)[];
  committed: number | null;
}

export interface ExplicitRollbackResult {
  repeatedRollbackSucceeded: boolean;
  operations: {
    operation: "put" | "sql" | "schedule";
    acknowledged: boolean;
    failure: {
      tag: "DurableObjectStorageError";
      wrappedBy: "CallbackError" | null;
      message: string;
    } | null;
  }[];
  snapshot: Snapshot;
}

export class AlarmObject extends Cloudflare.DurableObject<AlarmObject>()(
  "AlarmObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const storage = state.storage;

    return Effect.gen(function* () {
      const boots = ((yield* storage.get<number>("boots")) ?? 0) + 1;
      yield* storage.put("boots", boots);
      yield* storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS application_values (value TEXT NOT NULL)",
      );

      const record = Effect.fn(function* (callback: string, value: string) {
        const deliveries = (yield* storage.get<Delivery[]>("deliveries")) ?? [];
        yield* storage.put("deliveries", [
          ...deliveries,
          {
            callback,
            value,
            application: (yield* storage.get<string>("application")) ?? null,
            boots,
          },
        ]);
      });

      const archive: (payload: {
        value: string;
      }) => Effect.Effect<
        void,
        Alchemy.CallbackError | Cloudflare.DurableObjectStorageError,
        RuntimeContext
      > = Effect.fn(function* (payload: { value: string }) {
        if (payload.value === "replace-first") {
          yield* onArchive.schedule("replace", {
            after: "1 second",
            payload: { value: "replace-second" },
          });
        }
        yield* record("archive", payload.value);
      });

      const onArchive = yield* Alchemy.makeCallback("archive", archive);
      const onTransactionalRegistration = yield* storage
        .transaction(
          Alchemy.makeCallback(
            "transactional-init",
            Effect.fn(function* (payload: { value: string }) {
              yield* storage.put("application", payload.value);
              yield* record("transactional-init", payload.value);
            }),
          ),
        )
        .pipe(Effect.orDie);
      const onSecondary = yield* Alchemy.makeCallback(
        "secondary",
        Effect.fn(function* (payload: { value: string }) {
          yield* record("secondary", payload.value);
        }),
      );
      const onRetry = yield* Alchemy.makeCallback(
        "retry",
        Effect.fn(function* (payload: { value: string }) {
          const attempts = (yield* storage.get<Attempt[]>("attempts")) ?? [];
          yield* storage.put("attempts", [
            ...attempts,
            {
              now: yield* Effect.sync(() => Date.now()),
              recovery: yield* storage.getAlarm(),
              boots,
            },
          ]);
          if (attempts.length === 0) {
            yield* Effect.fail(new RetryArchive());
          }
          yield* record("retry", payload.value);
        }),
        { retry: { delay: "1 second" } },
      );
      const onCrash = yield* Alchemy.makeCallback(
        "crash",
        Effect.fn(function* (payload: { value: string; retryAlarm?: boolean }) {
          const attempts = (yield* storage.get<Attempt[]>("attempts")) ?? [];
          yield* storage.put("attempts", [
            ...attempts,
            {
              now: yield* Effect.sync(() => Date.now()),
              recovery: yield* storage.getAlarm(),
              boots,
            },
          ]);
          if (attempts.length === 0) {
            // abort cancels buffered writes; persist the one-shot crash marker first.
            yield* storage.sync();
            yield* state.abort("alarm callback crash", {
              retryAlarm: payload.retryAlarm ?? true,
            });
          }
          yield* record("crash", payload.value);
        }),
        { retry: { delay: "1 second" } },
      );
      const onOptional =
        (yield* storage.get<boolean>("optionalEnabled")) === false
          ? undefined
          : yield* Alchemy.makeCallback(
              "optional",
              Effect.fn(function* (payload: { value: string }) {
                yield* record("optional", payload.value);
              }),
              { retry: { delay: "1 second" } },
            );

      const snapshot = Effect.fn(function* () {
        const tables = yield* (yield* storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alchemy_alarm_callbacks'",
        )).toArray();
        const pendingJobs =
          tables.length === 0
            ? []
            : yield* (yield* storage.sql.exec<{
                callback: string;
                id: string;
                run_at: number;
                version: string;
              }>(
                "SELECT callback, id, run_at, version FROM alchemy_alarm_callbacks ORDER BY callback, id",
              )).toArray();
        const result: Snapshot = {
          id: yield* Effect.sync(() => state.id.toString()),
          boots,
          deliveries: (yield* storage.get<Delivery[]>("deliveries")) ?? [],
          attempts: (yield* storage.get<Attempt[]>("attempts")) ?? [],
          application: (yield* storage.get<string>("application")) ?? null,
          cleanupWrite: (yield* storage.get<string>("cleanupWrite")) ?? null,
          rows: yield* (yield* storage.sql.exec<{ value: string }>(
            "SELECT value FROM application_values ORDER BY value",
          )).toArray(),
          alarm: yield* storage.getAlarm(),
          pendingJobs,
        };
        return result;
      });

      const pending = Effect.fn(function* () {
        yield* onArchive.schedule("keep", {
          after: "2 seconds",
          payload: { value: "kept" },
        });
        return yield* storage.getAlarm();
      });
      const transactionalWrites = Effect.gen(function* () {
        yield* storage.put("application", "uncommitted");
        yield* storage.sql.exec(
          "INSERT INTO application_values (value) VALUES (?)",
          "uncommitted",
        );
        yield* onArchive.cancel("keep");
        yield* onArchive.schedule("rolled-back", {
          after: "1 second",
          payload: { value: "rolled-back" },
        });
      });
      const rollbackResult = Effect.fn(function* (
        failure: string,
        alarmBefore: number | null,
        cleanupWaited = true,
      ) {
        const alarmAfter = yield* storage.getAlarm();
        const result: RollbackResult = {
          failure,
          cleanupWaited,
          alarmBefore,
          alarmAfter,
          snapshot: yield* snapshot(),
        };
        yield* onArchive.schedule("checkpoint", {
          after: "3 seconds",
          payload: { value: "checkpoint" },
        });
        return result;
      });

      const measureBookkeeping = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const raw = state.raw.storage;
            const counts: BookkeepingCounts = {
              schemaChecks: 0,
              reconciliations: 0,
              setAlarm: 0,
              deleteAlarm: 0,
            };
            const exec = raw.sql.exec;
            const setAlarm = raw.setAlarm;
            const deleteAlarm = raw.deleteAlarm;
            raw.sql.exec = function <
              T extends Record<string, Cloudflare.SqlStorageValue>,
            >(query: string, ...bindings: Cloudflare.SqlStorageValue[]) {
              if (
                query.includes("SELECT name FROM sqlite_master") &&
                query.includes("alchemy_alarm_schema")
              )
                counts.schemaChecks++;
              if (query.includes("SELECT MIN(run_at) AS run_at FROM (")) {
                counts.reconciliations++;
              }
              return exec.call(raw.sql, query, ...bindings) as ReturnType<
                typeof raw.sql.exec<T>
              >;
            };
            raw.setAlarm = (at, options) => {
              counts.setAlarm++;
              return setAlarm.call(raw, at, options);
            };
            raw.deleteAlarm = (options) => {
              counts.deleteAlarm++;
              return deleteAlarm.call(raw, options);
            };
            return { raw, counts, exec, setAlarm, deleteAlarm };
          }),
          ({ counts }) => effect.pipe(Effect.as(counts)),
          ({ raw, exec, setAlarm, deleteAlarm }) =>
            Effect.sync(() => {
              raw.sql.exec = exec;
              raw.setAlarm = setAlarm;
              raw.deleteAlarm = deleteAlarm;
            }),
        );

      return {
        snapshot,
        bookkeeping: Effect.fn(function* () {
          const at = yield* Effect.sync(() => Date.now() + 1_500);
          const counts = yield* measureBookkeeping(
            storage
              .transaction(
                Effect.gen(function* () {
                  for (let i = 0; i < 20; i++) {
                    yield* onArchive.schedule(`cancelled-${i}`, {
                      at,
                      payload: { value: "cancelled" },
                    });
                    yield* onArchive.cancel(`cancelled-${i}`);
                  }
                  yield* onArchive.schedule("kept", {
                    at,
                    payload: { value: "batched" },
                  });
                  yield* storage.transaction(
                    Effect.gen(function* () {
                      yield* onSecondary.schedule("kept", {
                        at,
                        payload: { value: "nested" },
                      });
                      yield* Cloudflare.scheduleEvent(
                        "cancelled-legacy",
                        new Date(at),
                        {},
                      );
                      yield* Cloudflare.cancelEvent("cancelled-legacy");
                    }),
                  );
                  yield* Effect.addFinalizer(() =>
                    onArchive
                      .schedule("finalizer", {
                        at,
                        payload: { value: "finalizer" },
                      })
                      .pipe(Effect.orDie),
                  );
                }),
              )
              .pipe(
                Effect.provideService(Cloudflare.DurableObjectState, state),
              ),
          );
          const result: BatchResult = { counts, snapshot: yield* snapshot() };
          return result;
        }),
        cancelBookkeeping: Effect.fn(function* () {
          yield* onArchive.schedule("cancelled", {
            after: "1 minute",
            payload: { value: "cancelled" },
          });
          const counts = yield* measureBookkeeping(
            storage.transaction(
              Effect.gen(function* () {
                yield* onArchive.cancel("cancelled");
                for (let i = 0; i < 20; i++)
                  yield* onArchive.cancel(`missing-${i}`);
              }),
            ),
          );
          const result: BatchResult = { counts, snapshot: yield* snapshot() };
          return result;
        }),
        failedBookkeeping: Effect.fn(function* (explicit: boolean) {
          let failure: string | null = null;
          const counts = yield* measureBookkeeping(
            storage
              .transaction(
                Effect.fn(function* (txn: Cloudflare.DurableObjectTransaction) {
                  yield* storage.put("application", "uncommitted");
                  yield* storage.sql.exec(
                    "INSERT INTO application_values (value) VALUES ('uncommitted')",
                  );
                  yield* onArchive.schedule("rolled-back", {
                    after: "1 minute",
                    payload: { value: "rolled-back" },
                  });
                  if (explicit) {
                    yield* txn.rollback();
                  } else {
                    // A real SQLite failure during deferred reconciliation must roll back the batch.
                    yield* storage.sql.exec(
                      "DROP TABLE alchemy_alarm_callbacks",
                    );
                  }
                }),
              )
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Effect.sync(() => {
                    failure = Exit.isFailure(exit)
                      ? String(Cause.squash(exit.cause))
                      : null;
                  }),
                ),
              ),
          );
          const rolledBack: BatchResult = {
            counts,
            snapshot: yield* snapshot(),
          };
          const recovered = yield* measureBookkeeping(
            storage.transaction(
              Effect.gen(function* () {
                yield* onArchive.schedule("recovered", {
                  after: "1 second",
                  payload: { value: "recovered" },
                });
                yield* onArchive.cancel("missing");
              }),
            ),
          );
          const result: FailedBatchResult = {
            failure,
            rolledBack,
            recovered: { counts: recovered, snapshot: yield* snapshot() },
          };
          return result;
        }),
        alarmObservations: Effect.fn(function* () {
          const at = yield* Effect.sync(() => Date.now() + 60_000);
          const observations = yield* storage.transaction(
            Effect.fn(function* (txn: Cloudflare.DurableObjectTransaction) {
              const values: (number | null)[] = [];
              yield* onArchive.schedule("observed", {
                at,
                payload: { value: "observed" },
              });
              values.push(yield* storage.getAlarm());
              yield* onArchive.cancel("observed");
              values.push(yield* txn.getAlarm());
              yield* onArchive.schedule("observed", {
                at,
                payload: { value: "observed" },
              });
              yield* txn.setAlarm(at + 1_000);
              values.push(yield* storage.getAlarm());
              yield* onArchive.cancel("observed");
              yield* storage.setAlarm(at + 2_000);
              values.push(yield* txn.getAlarm());
              yield* onArchive.schedule("observed", {
                at,
                payload: { value: "observed" },
              });
              yield* txn.deleteAlarm();
              values.push(yield* storage.getAlarm());
              yield* onArchive.schedule("observed", {
                at,
                payload: { value: "observed" },
              });
              yield* storage.deleteAlarm();
              values.push(yield* txn.getAlarm());
              yield* onArchive.cancel("observed");
              yield* txn.setAlarm(at + 3_000);
              return values;
            }),
          );
          const committed = yield* storage.getAlarm();
          yield* storage.deleteAlarm();
          const result: AlarmObservationResult = {
            at,
            observations,
            committed,
          };
          return result;
        }),
        registerLate: Effect.fn(function* () {
          const exit = yield* Effect.exit(
            Alchemy.makeCallback(
              "late",
              (_payload: { value: string }) => Effect.void,
            ),
          );
          const defect = Exit.isFailure(exit)
            ? Result.getOrUndefined(Cause.findDefect(exit.cause))
            : undefined;
          const result: RegistrationResult = {
            failure:
              defect instanceof Alchemy.CallbackError
                ? {
                    tag: defect._tag,
                    callback: defect.callback,
                    message: defect.message,
                  }
                : null,
            snapshot: yield* snapshot(),
          };
          return result;
        }),
        timing: Effect.fn(function* () {
          const at = yield* Effect.sync(() => Date.now() + 1_500);
          yield* storage.transaction(
            Effect.gen(function* () {
              yield* onArchive.schedule("same", {
                after: "1 second",
                payload: { value: "superseded" },
              });
              yield* onArchive.schedule("same", {
                at,
                payload: { value: "latest" },
              });
              yield* onSecondary.schedule("same", {
                at,
                payload: { value: "other-callback" },
              });
              yield* onArchive.schedule("cancelled", {
                at,
                payload: { value: "cancelled" },
              });
              yield* onArchive.cancel("cancelled");
              yield* onArchive.cancel("missing");
              yield* onArchive.schedule("date", {
                at: new Date(at),
                payload: { value: "date" },
              });
              yield* onArchive.schedule("duration", {
                after: Duration.millis(1_500),
                payload: { value: "duration" },
              });
              yield* onArchive.schedule("checkpoint", {
                after: "3 seconds",
                payload: { value: "checkpoint" },
              });
            }),
          );
          return yield* snapshot();
        }),
        atomic: Effect.fn(function* () {
          const marker = yield* storage
            .transaction(
              Effect.gen(function* () {
                const { value } = yield* TransactionMarker;
                yield* storage.put("application", value);
                yield* storage.sql.exec(
                  "INSERT INTO application_values (value) VALUES (?)",
                  value,
                );
                yield* onArchive.schedule("atomic", {
                  after: "1 second",
                  payload: { value },
                });
                return value;
              }),
            )
            .pipe(
              Effect.provideService(TransactionMarker, { value: "committed" }),
            );
          const legacyOverload = yield* storage
            .transaction(
              Effect.fn(function* (
                transaction: Cloudflare.DurableObjectTransaction,
              ) {
                const { value } = yield* TransactionMarker;
                yield* transaction.put("legacyOverload", value);
                return yield* transaction.get<string>("legacyOverload");
              }),
            )
            .pipe(
              Effect.provideService(TransactionMarker, { value: "callback" }),
            );
          return { marker, legacyOverload, snapshot: yield* snapshot() };
        }),
        transactionalRegistration: Effect.fn(function* () {
          yield* onTransactionalRegistration.schedule("transactional-init", {
            after: "1 second",
            payload: { value: "registered-in-transaction" },
          });
          return yield* snapshot();
        }),
        siblingTransaction: Effect.fn(function* () {
          // Native input gates can block timers used for fiber scheduling.
          const scheduler = yield* Effect.sync(
            () => new Scheduler.MixedScheduler("sync"),
          );
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const ready = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const completed = yield* Deferred.make<void>();
              const sibling = yield* Effect.gen(function* () {
                yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(release);
                yield* storage.put("siblingWrite", "independent-write");
              }).pipe(
                Effect.timeout("2 seconds"),
                Effect.exit,
                Effect.tap(() => Deferred.succeed(completed, undefined)),
                Effect.forkScoped,
              );
              yield* Deferred.await(ready).pipe(
                Effect.timeout("2 seconds"),
                Effect.orDie,
              );
              const failure = yield* storage
                .transaction(
                  Effect.gen(function* () {
                    yield* storage.put("application", "uncommitted");
                    yield* storage.sql.exec(
                      "INSERT INTO application_values (value) VALUES (?)",
                      "uncommitted",
                    );
                    yield* Deferred.succeed(release, undefined);
                    yield* Deferred.await(completed).pipe(
                      Effect.timeout("2 seconds"),
                      Effect.orDie,
                    );
                    return yield* Effect.fail(
                      new Rollback({ value: "sibling-rollback" }),
                    );
                  }),
                )
                .pipe(
                  Effect.catchTag("Rollback", (error) =>
                    Effect.succeed(error.value),
                  ),
                );
              const exit = yield* Fiber.join(sibling).pipe(
                Effect.timeout("2 seconds"),
                Effect.orDie,
              );
              const error = Exit.isFailure(exit)
                ? Cause.squash(exit.cause)
                : undefined;
              const result: SiblingTransactionResult = {
                failure,
                siblingAcknowledged: Exit.isSuccess(exit),
                siblingFailure:
                  error instanceof Cloudflare.DurableObjectStorageError
                    ? {
                        tag: error._tag,
                        operation: error.operation,
                        message: error.message,
                      }
                    : null,
                siblingValue:
                  (yield* storage.get<string>("siblingWrite")) ?? null,
                snapshot: yield* snapshot(),
              };
              return result;
            }),
          ).pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
        }),
        rollbackExplicit: Effect.fn(function* () {
          const describeOperation = <A, E>(
            operation: ExplicitRollbackResult["operations"][number]["operation"],
            exit: Exit.Exit<A, E>,
          ): ExplicitRollbackResult["operations"][number] => {
            const error = Exit.isFailure(exit)
              ? Cause.squash(exit.cause)
              : undefined;
            const cause =
              error instanceof Alchemy.CallbackError ? error.cause : error;
            return {
              operation,
              acknowledged: Exit.isSuccess(exit),
              failure:
                cause instanceof Cloudflare.DurableObjectStorageError
                  ? {
                      tag: cause._tag,
                      wrappedBy:
                        error instanceof Alchemy.CallbackError
                          ? error._tag
                          : null,
                      message: cause.message,
                    }
                  : null,
            };
          };
          const outcome = yield* storage.transaction(
            Effect.fn(function* (txn: Cloudflare.DurableObjectTransaction) {
              yield* txn.put("application", "before-rollback");
              yield* storage.sql.exec(
                "INSERT INTO application_values (value) VALUES (?)",
                "before-rollback",
              );
              yield* onArchive.schedule("before-explicit-rollback", {
                after: "1 minute",
                payload: { value: "before-rollback" },
              });
              yield* txn.rollback();
              const repeatedRollback = yield* Effect.exit(txn.rollback());
              const put = yield* Effect.exit(
                storage.put("application", "after-rollback"),
              );
              const sql = yield* Effect.exit(
                storage.sql.exec(
                  "INSERT INTO application_values (value) VALUES (?)",
                  "after-rollback",
                ),
              );
              const schedule = yield* Effect.exit(
                onArchive.schedule("after-explicit-rollback", {
                  after: "1 minute",
                  payload: { value: "after-rollback" },
                }),
              );
              return {
                repeatedRollbackSucceeded: Exit.isSuccess(repeatedRollback),
                operations: [
                  describeOperation("put", put),
                  describeOperation("sql", sql),
                  describeOperation("schedule", schedule),
                ],
              };
            }),
          );
          const result: ExplicitRollbackResult = {
            ...outcome,
            snapshot: yield* snapshot(),
          };
          return result;
        }),
        rollbackTyped: Effect.fn(function* () {
          const alarmBefore = yield* pending();
          const failure = yield* storage
            .transaction(
              Effect.gen(function* () {
                yield* transactionalWrites;
                return yield* Effect.fail(
                  new Rollback({ value: "typed-value" }),
                );
              }),
            )
            .pipe(
              Effect.catchTag("Rollback", (error) =>
                Effect.succeed(error.value),
              ),
            );
          return yield* rollbackResult(failure, alarmBefore);
        }),
        rollbackDefect: Effect.fn(function* () {
          const alarmBefore = yield* pending();
          const exit = yield* storage
            .transaction(
              Effect.gen(function* () {
                yield* transactionalWrites;
                yield* storage.getAlarm();
                return yield* Effect.die("rollback-defect");
              }),
            )
            .pipe(Effect.exit);
          const failure =
            Exit.isFailure(exit) &&
            Cause.squash(exit.cause) === "rollback-defect"
              ? "defect"
              : "unexpected";
          return yield* rollbackResult(failure, alarmBefore);
        }),
        rollbackInterrupt: Effect.fn(function* () {
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const alarmBefore = yield* pending();
              const entered = yield* Deferred.make<void>();
              const cleanupStarted = yield* Deferred.make<void>();
              const releaseCleanup = yield* Deferred.make<void>();
              const interruptFinished = yield* Deferred.make<void>();
              const cleaned = yield* Ref.make(false);
              const fiber = yield* storage
                .transaction(
                  Effect.gen(function* () {
                    yield* transactionalWrites;
                    yield* storage.getAlarm();
                    yield* Deferred.succeed(entered, undefined);
                    yield* Effect.never.pipe(
                      Effect.timeout("5 seconds"),
                      Effect.orDie,
                    );
                  }).pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        yield* Deferred.succeed(cleanupStarted, undefined);
                        yield* Deferred.await(releaseCleanup).pipe(
                          Effect.timeout("2 seconds"),
                          Effect.orDie,
                        );
                        yield* storage.put("cleanupWrite", "rolled-back");
                        yield* Ref.set(cleaned, true);
                      }),
                    ),
                  ),
                )
                .pipe(Effect.forkScoped);
              yield* Deferred.await(entered).pipe(
                Effect.timeout("5 seconds"),
                Effect.orDie,
              );
              const interrupter = yield* Fiber.interrupt(fiber).pipe(
                Effect.andThen(Deferred.succeed(interruptFinished, undefined)),
                Effect.forkScoped,
              );
              yield* Deferred.await(cleanupStarted).pipe(
                Effect.timeout("8 seconds"),
                Effect.orDie,
              );
              const finishedEarly = yield* Deferred.isDone(interruptFinished);
              yield* Deferred.succeed(releaseCleanup, undefined);
              yield* Fiber.join(interrupter);
              const exit = yield* Fiber.await(fiber);
              const failure =
                Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                  ? "interrupted"
                  : "unexpected";
              return yield* rollbackResult(
                failure,
                alarmBefore,
                !finishedEarly && (yield* Ref.get(cleaned)),
              );
            }),
          );
        }),
        retry: Effect.fn(function* () {
          yield* onRetry.schedule("retry", {
            after: "1 second",
            payload: { value: "retried" },
          });
        }),
        replace: Effect.fn(function* () {
          yield* onArchive.schedule("replace", {
            after: "1 second",
            payload: { value: "replace-first" },
          });
        }),
        recovery: Effect.fn(function* (retryAlarm = true) {
          yield* onCrash.schedule("recovery", {
            after: "1 second",
            payload: { value: "recovered", retryAlarm },
          });
        }),
        wake: Effect.fn(function* () {
          const now = yield* Effect.sync(() => Date.now());
          yield* storage.setAlarm(now);
        }),
        prepareReset: Effect.fn(function* (value: string) {
          yield* onArchive.schedule("reset", {
            after: "5 minutes",
            payload: { value },
          });
          return yield* snapshot();
        }),
        optional: Effect.fn(function* () {
          if (!onOptional) {
            return yield* Effect.die("optional callback not registered");
          }
          yield* onOptional.schedule("optional", {
            after: "5 minutes",
            payload: { value: "retained" },
          });
          yield* storage.put("optionalEnabled", false);
          return yield* snapshot();
        }),
        releasePending: Effect.fn(function* () {
          // Preserve persisted jobs until reconstruction, then advance only their due times.
          const at = yield* Effect.sync(() => Date.now() + 1_000);
          yield* storage.transaction(
            Effect.gen(function* () {
              yield* storage.sql.exec(
                "UPDATE alchemy_alarm_callbacks SET run_at = ?",
                at,
              );
              yield* storage.setAlarm(at);
            }),
          );
          return yield* snapshot();
        }),
        enableOptional: Effect.fn(function* () {
          yield* storage.put("optionalEnabled", true);
        }),
        batch: Effect.fn(function* () {
          const at = yield* Effect.sync(() => Date.now() + 1_500);
          yield* storage.transaction(
            Effect.gen(function* () {
              for (let i = 0; i < 105; i++) {
                yield* onArchive.schedule(`batch-${i}`, {
                  at,
                  payload: { value: `batch-${i}` },
                });
              }
            }),
          );
        }),
        crash: Effect.fn(function* () {
          yield* state.abort("alarm callback reconstruction", {
            retryAlarm: false,
          });
        }),
      };
    });
  }),
) {}
