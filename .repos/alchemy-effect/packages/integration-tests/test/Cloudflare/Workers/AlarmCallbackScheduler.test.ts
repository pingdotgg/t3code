import { describe, expect, it } from "@alchemy.run/test";
import { CallbackError, type Callback, type CallbackOptions } from "alchemy/Callback";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { makeAlarmScheduler } from "./fixtures/alarm-scheduler.ts";

describe(
  "durable callback scheduling policy",
  {
    tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:worker"],
  },
  () => {
    it.effect("acknowledges a successful job after persisting its recovery wake", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const delivered: string[] = [];
        const callback = yield* fixture.register("archive", (payload: string) =>
          Effect.gen(function* () {
            expect(fixture.alarm!).toBeGreaterThan(yield* Clock.currentTimeMillis);
            delivered.push(payload);
          }),
        );
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: "saved" });
        yield* fixture.fire;
        expect(delivered).toEqual(["saved"]);
        expect(fixture.alarm).toBeNull();
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("backs off failures durably across instance reconstruction", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const register = () =>
          fixture.register("broken", () => Effect.fail("unavailable"), {
            retry: { delay: "1 second" },
          });
        const callback = yield* register();
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: null });
        yield* fixture.fire;
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(1_000);
        fixture.restart();
        yield* register();
        fixture.seal();
        yield* fixture.fire;
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(2_000);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    for (const changeId of [false, true]) {
      it.effect(
        `bounds successful self-rearms${changeId ? " across cancellation and changed IDs" : ""}`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* makeAlarmScheduler;
            let deliveries = 0;
            const callback: Callback<null> = yield* fixture.register(
              "loop",
              () =>
                Effect.gen(function* () {
                  yield* callback.cancel(String(changeId ? deliveries : 0));
                  deliveries++;
                  yield* callback.schedule(String(changeId ? deliveries : 0), {
                    after: 0,
                    payload: null,
                  });
                }),
              { retry: { delay: "1 second" } },
            );
            fixture.seal();
            yield* callback.schedule("0", { after: 0, payload: null });
            for (const delay of [
              1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 3_600_000, 3_600_000,
            ]) {
              yield* fixture.fire;
              expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(delay);
            }
            expect(deliveries).toBe(9);
          }).pipe(Effect.provide(RuntimeContext.phantom)),
      );
    }

    it.effect(
      "spaces retries from failure completion when a handler outlasts its recovery delay",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          const callback = yield* fixture.register(
            "slow",
            () =>
              Effect.gen(function* () {
                yield* TestClock.adjust("10 seconds");
                return yield* Effect.fail("still unavailable");
              }),
            { retry: { delay: "1 second" } },
          );
          fixture.seal();
          yield* callback.schedule("a", { after: 0, payload: null });
          yield* fixture.fire;
          expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(1_000);
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("parks repeated failures and preserves parking after reconstruction", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const register = () =>
          fixture.register("broken", () => Effect.fail("unavailable"), {
            retry: { delay: "1 second" },
          });
        const callback = yield* register();
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: null });
        for (let attempt = 0; attempt < 8; attempt++) yield* fixture.fire;
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(3_600_000);
        fixture.restart();
        yield* register();
        fixture.seal();
        yield* fixture.fire;
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(3_600_000);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("enforces a one-second floor for subsecond retry delays", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const callback = yield* fixture.register("broken", () => Effect.fail("unavailable"), {
          retry: { delay: "1 millis" },
        });
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: null });
        yield* fixture.fire;
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(1_000);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("rejects a detached self-rearm after the callback invocation ends", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const release = yield* Deferred.make<void>();
        let detached: Fiber.Fiber<void, unknown> | undefined;
        const callback: Callback<null> = yield* fixture.register("detached", () =>
          Effect.gen(function* () {
            detached = yield* Deferred.await(release).pipe(
              Effect.andThen(() => callback.schedule("a", { after: 0, payload: null })),
              Effect.forkDetach,
            );
          }),
        );
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: null });
        yield* fixture.fire;
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(detached!))).toBe(true);
        expect(fixture.alarm).toBeNull();
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("continues unrelated due work when a callback fails", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        let delivered = false;
        const broken = yield* fixture.register("a", () => Effect.fail("unavailable"));
        const healthy = yield* fixture.register("b", () =>
          Effect.sync(() => {
            delivered = true;
          }),
        );
        fixture.seal();
        yield* broken.schedule("a", { after: 0, payload: null });
        yield* healthy.schedule("b", { after: 0, payload: null });
        yield* fixture.fire;
        expect(delivered).toBe(true);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect(
      "preserves the requested deadline and inspects status without decoding payloads",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          const callback = yield* fixture.register("broken", () => Effect.fail("unavailable"), {
            retry: { delay: "1 second" },
          });
          fixture.seal();
          yield* callback.schedule("a", {
            at: 15_000,
            payload: null,
            progress: 0,
          });
          expect(yield* callback.getStatus("a")).toEqual({
            scheduledAt: 15_000,
            retryAt: undefined,
            attempts: 0,
            parked: false,
            progress: 0,
          });
          yield* fixture.fire;
          const status = yield* callback.getStatus("a");
          expect(status).toEqual({
            scheduledAt: 15_000,
            retryAt: 16_000,
            attempts: 1,
            parked: false,
            progress: 0,
          });
          fixture.db.run("UPDATE alchemy_alarm_callbacks SET payload = 'invalid json'");
          expect(yield* callback.getStatus("a")).toEqual(status);
          yield* callback.cancel("a");
          expect(yield* callback.getStatus("a")).toBeUndefined();
          expect(fixture.alarm).toBeNull();
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect(
      "keeps parked jobs parked when the budget grows and resumes only on new progress or external enrollment",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          const register = (maxAttempts: number) =>
            fixture.register("broken", () => Effect.fail("unavailable"), {
              retry: {
                delay: "2 seconds",
                maxAttempts,
                parkedDelay: "2 hours",
              },
            });
          let callback = yield* register(2);
          fixture.seal();
          yield* callback.schedule("a", {
            after: 0,
            payload: null,
            progress: 1,
          });
          yield* fixture.fire;
          yield* fixture.fire;
          const parked = yield* callback.getStatus("a");
          expect(parked?.parked).toBe(true);
          expect(parked?.attempts).toBe(2);
          expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(7_200_000);
          fixture.restart();
          callback = yield* register(20);
          fixture.seal();
          yield* fixture.fire;
          expect((yield* callback.getStatus("a"))?.attempts).toBe(2);
          expect((yield* callback.getStatus("a"))?.parked).toBe(true);
          const nextWake = fixture.alarm;
          for (const progress of [0, 1]) {
            yield* callback.schedule("a", {
              after: 0,
              payload: "stale",
              progress,
            });
            expect(fixture.alarm).toBe(nextWake);
          }
          yield* callback.schedule("a", {
            after: 0,
            payload: "new",
            progress: 2,
          });
          expect(yield* callback.getStatus("a")).toEqual({
            scheduledAt: yield* Clock.currentTimeMillis,
            retryAt: undefined,
            attempts: 0,
            parked: false,
            progress: 2,
          });
          yield* fixture.fire;
          yield* callback.schedule("a", {
            after: 0,
            payload: "explicit recovery",
          });
          expect((yield* callback.getStatus("a"))?.attempts).toBe(0);
          expect((yield* callback.getStatus("a"))?.progress).toBe(2);
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("weighs another callback's cursor without letting it hide a schedule", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const delivered: string[] = [];
        const target = yield* fixture.register(
          "target",
          (id: string) => Effect.sync(() => delivered.push(id)),
          { retry: { delay: "1 second" } },
        );
        const source = yield* fixture.register(
          "source",
          () =>
            Effect.gen(function* () {
              yield* target.schedule("behind", { after: 0, payload: "behind", progress: 1 });
              yield* target.schedule("past", { after: 0, payload: "past", progress: 101 });
            }),
          { retry: { delay: "1 second" } },
        );
        fixture.seal();
        yield* source.schedule("s", { after: 0, payload: null, progress: 100 });
        yield* fixture.fire;
        // Behind the source's cursor: scheduled under its own cursor, with the
        // source's budget. Past it: progress, so a fresh budget.
        expect(yield* target.getStatus("behind")).toMatchObject({ attempts: 1, progress: 1 });
        expect(yield* target.getStatus("past")).toMatchObject({ attempts: 0, progress: 101 });
        yield* fixture.fire;
        expect(delivered).toEqual(["past"]);
        yield* fixture.fire;
        expect(delivered).toEqual(["past", "behind"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    for (const changeId of [false, true]) {
      it.effect(
        `resets the budget for committed forward progress${changeId ? " across IDs" : ""}`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* makeAlarmScheduler;
            fixture.db.exec(
              "CREATE TABLE source (version INTEGER NOT NULL); INSERT INTO source VALUES (0)",
            );
            let version = 0;
            const callback: Callback<null> = yield* fixture.register(
              "progress",
              () =>
                fixture.state.storage.transaction(
                  Effect.gen(function* () {
                    version++;
                    yield* fixture.state.storage.sql.exec("UPDATE source SET version = ?", version);
                    yield* callback.schedule(String(changeId ? version : 0), {
                      after: 0,
                      payload: null,
                      progress: version,
                    });
                  }),
                ),
              { retry: { delay: "1 second", maxAttempts: 2 } },
            );
            fixture.seal();
            yield* callback.schedule("0", {
              after: 0,
              payload: null,
              progress: 0,
            });
            for (let i = 1; i <= 8; i++) {
              yield* fixture.fire;
              const status = yield* callback.getStatus(String(changeId ? i : 0));
              expect(status?.attempts).toBe(0);
              expect(status?.parked).toBe(false);
              expect(status?.progress).toBe(i);
              expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(1);
            }
            expect(fixture.db.query("SELECT version FROM source").get()).toEqual({ version: 8 });
          }).pipe(Effect.provide(RuntimeContext.phantom)),
      );
    }

    it.effect(
      "rolls back application progress and self-rearms together without undoing the persisted recovery attempt",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          fixture.db.exec(
            "CREATE TABLE source (version INTEGER NOT NULL); INSERT INTO source VALUES (0)",
          );
          const callback: Callback<null> = yield* fixture.register(
            "rollback",
            () =>
              fixture.state.storage.transaction(
                Effect.gen(function* () {
                  yield* fixture.state.storage.sql.exec("UPDATE source SET version = 1");
                  yield* callback.schedule("a", {
                    after: 0,
                    payload: null,
                    progress: 1,
                  });
                  return yield* Effect.fail("rollback progress");
                }),
              ),
            { retry: { delay: "1 second", maxAttempts: 1 } },
          );
          fixture.seal();
          yield* callback.schedule("a", {
            at: 15_000,
            payload: null,
            progress: 0,
          });
          yield* fixture.fire;
          expect(fixture.db.query("SELECT version FROM source").get()).toEqual({
            version: 0,
          });
          expect(yield* callback.getStatus("a")).toEqual({
            scheduledAt: 15_000,
            retryAt: 3_615_000,
            attempts: 1,
            parked: true,
            progress: 0,
          });
          expect(fixture.alarm).toBe(3_615_000);
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect(
      "charges multiple self-rearms followed by failure only once and preserves the last replacement",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          const callback: Callback<string> = yield* fixture.register(
            "replace",
            () =>
              Effect.gen(function* () {
                yield* callback.schedule("a", {
                  after: "1 minute",
                  payload: "first",
                });
                yield* callback.schedule("a", {
                  after: "2 minutes",
                  payload: "last",
                });
                return yield* Effect.fail("old attempt failed");
              }),
            { retry: { delay: "1 second" } },
          );
          fixture.seal();
          yield* callback.schedule("a", { after: 0, payload: "initial" });
          yield* fixture.fire;
          const now = yield* Clock.currentTimeMillis;
          expect(yield* callback.getStatus("a")).toEqual({
            scheduledAt: now + 120_000,
            retryAt: now + 1_000,
            attempts: 1,
            parked: false,
            progress: undefined,
          });
          expect(fixture.alarm).toBe(now + 120_000);
          expect(fixture.db.query("SELECT payload FROM alchemy_alarm_callbacks").get()).toEqual({
            payload: '"last"',
          });
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("does not overwrite an external replacement when an older delivery fails", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const callback = yield* fixture.register(
          "replace",
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.fail("stale failure");
            }),
          { retry: { delay: "1 second" } },
        );
        fixture.seal();
        yield* callback.schedule("a", {
          after: 0,
          payload: null,
          progress: 1,
        });
        const delivery = yield* fixture.fire.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* callback.schedule("a", {
          after: "5 minutes",
          payload: "replacement",
          progress: 2,
        });
        const replacement = yield* callback.getStatus("a");
        const wake = fixture.alarm;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(delivery);
        expect(yield* callback.getStatus("a")).toEqual(replacement);
        expect(fixture.alarm).toBe(wake);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("parks missing handlers and delivers retained work when the handler returns", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const callback = yield* fixture.register("removed", () => Effect.void);
        fixture.seal();
        yield* callback.schedule("a", { after: 0, payload: null });
        fixture.restart();
        fixture.seal();
        for (let i = 0; i < 8; i++) yield* fixture.fire;
        expect((yield* callback.getStatus("a"))?.parked).toBe(true);
        expect(fixture.alarm! - (yield* Clock.currentTimeMillis)).toBe(3_600_000);
        fixture.restart();
        let delivered = false;
        yield* fixture.register("removed", () =>
          Effect.sync(() => {
            delivered = true;
          }),
        );
        fixture.seal();
        yield* fixture.fire;
        expect(delivered).toBe(true);
        expect(yield* callback.getStatus("a")).toBeUndefined();
        expect(fixture.alarm).toBeNull();
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect(
      "migrates version-one callback rows atomically while preserving their native wake",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          fixture.db.exec(`
        CREATE TABLE alchemy_alarm_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO alchemy_alarm_schema VALUES (1, 1);
        CREATE TABLE alchemy_scheduled_events (id TEXT PRIMARY KEY, run_at INTEGER NOT NULL, repeat_ms INTEGER, payload TEXT NOT NULL);
        CREATE TABLE alchemy_alarm_callbacks (
          callback TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL,
          run_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (callback, id)
        );
        CREATE INDEX idx_alchemy_alarm_callbacks_run_at ON alchemy_alarm_callbacks (run_at, callback, id);
        INSERT INTO alchemy_alarm_callbacks VALUES ('legacy', 'a', 'existing-version', 15000, 'null');
      `);
          yield* Effect.promise(() => fixture.raw.storage.setAlarm(15_000));
          const before = fixture.db.query("SELECT * FROM sqlite_master ORDER BY name").all();
          const callback = yield* fixture.register("legacy", () => Effect.void);
          fixture.seal();
          const rollback = yield* fixture.state.storage
            .transaction(
              Effect.gen(function* () {
                yield* callback.getStatus("a");
                return yield* Effect.fail("rollback migration");
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(rollback)).toBe(true);
          expect(fixture.db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(
            before,
          );
          expect(fixture.alarm).toBe(15_000);
          expect(yield* callback.getStatus("a")).toEqual({
            scheduledAt: 15_000,
            retryAt: undefined,
            attempts: 0,
            parked: false,
            progress: undefined,
          });
          expect(fixture.db.query("SELECT version FROM alchemy_alarm_schema").get()).toEqual({
            version: 2,
          });
          expect(
            fixture.db.query("SELECT version, payload FROM alchemy_alarm_callbacks").get(),
          ).toEqual({ version: "existing-version", payload: "null" });
          expect(fixture.alarm).toBe(15_000);
          yield* fixture.fire;
          expect(fixture.alarm).toBeNull();
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    for (const retry of [
      { delay: 0 },
      { delay: Infinity },
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
      { maxAttempts: Infinity },
      { parkedDelay: "59 minutes" },
      { parkedDelay: Infinity },
      { delay: "2 hours", parkedDelay: "1 hour" },
    ] satisfies NonNullable<CallbackOptions["retry"]>[]) {
      it.effect(`rejects invalid retry policy ${JSON.stringify(retry)}`, () =>
        Effect.gen(function* () {
          const fixture = yield* makeAlarmScheduler;
          const exit = yield* fixture
            .register("invalid", () => Effect.void, { retry })
            .pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(CallbackError);
          expect(fixture.alarm).toBeNull();
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      );
    }

    it.effect("rejects invalid source cursors without replacing pending work", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const callback = yield* fixture.register("invalid", () => Effect.void);
        fixture.seal();
        yield* callback.schedule("a", { after: "1 minute", payload: null });
        const before = yield* callback.getStatus("a");
        for (const progress of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          const exit = yield* callback
            .schedule("a", { after: 0, payload: null, progress })
            .pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(yield* callback.getStatus("a")).toEqual(before);
        }
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
    it.effect("reports committed parking once even when a later rearm rolls back", () => {
      const reports: unknown[][] = [];
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message) && message[0] === "Durable Object alarm callback parked") {
          reports.push(message);
        }
      });
      return Effect.gen(function* () {
        const fixture = yield* makeAlarmScheduler;
        const callback: Callback<string> = yield* fixture.register(
          "PRIVATE_CALLBACK",
          () =>
            fixture.state.storage.transaction(
              Effect.gen(function* () {
                yield* callback.schedule("PRIVATE_ID", {
                  after: 0,
                  payload: "PRIVATE_PAYLOAD",
                });
                return yield* Effect.fail("rollback rearm");
              }),
            ),
          { retry: { delay: "1 second", maxAttempts: 1 } },
        );
        fixture.seal();
        yield* callback.schedule("PRIVATE_ID", {
          after: 0,
          payload: "PRIVATE_PAYLOAD",
        });
        yield* fixture.fire;
        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual([
          "Durable Object alarm callback parked",
          { attempts: 1, retryAt: fixture.alarm },
        ]);
        yield* fixture.fire;
        expect(reports).toHaveLength(1);
      }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provide(RuntimeContext.phantom),
      );
    });
  },
);
