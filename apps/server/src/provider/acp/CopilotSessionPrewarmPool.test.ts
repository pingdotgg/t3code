import { Duration, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import type { AcpSessionRuntimeShape, AcpSpawnInput } from "./AcpSessionRuntime.ts";
import {
  COPILOT_PREWARM_TTL_MS,
  COPILOT_PREWARM_WARMUP_TIMEOUT_MS,
  copilotPrewarmKey,
  type CopilotPrewarmRequest,
  makeCopilotSessionPrewarmPool,
} from "./CopilotSessionPrewarmPool.ts";

const spawnOf = (overrides: Partial<AcpSpawnInput> = {}): AcpSpawnInput =>
  ({
    command: "copilot",
    args: ["--acp"],
    cwd: "/repo",
    env: { A: "1" },
    ...overrides,
  }) as AcpSpawnInput;

const requestOf = (spawn: AcpSpawnInput): CopilotPrewarmRequest =>
  ({ spawn, runtimeOptions: {}, childProcessSpawner: {} }) as unknown as CopilotPrewarmRequest;

interface FakeProcess {
  readonly spawn: AcpSpawnInput;
  alive: boolean;
  closed: boolean;
}

/**
 * Builds a fake warmed runtime that records whether its scope was closed, so a
 * test can assert the pool tears down exactly the processes it discards.
 */
const makeFakeBuilder = (processes: Array<FakeProcess>) => {
  const builder = (request: CopilotPrewarmRequest) =>
    Effect.gen(function* () {
      const record: FakeProcess = { spawn: request.spawn, alive: true, closed: false };
      processes.push(record);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          record.closed = true;
        }),
      );
      return {
        isProcessAlive: Effect.sync(() => record.alive),
      } as unknown as AcpSessionRuntimeShape;
    });
  return builder;
};

describe("copilotPrewarmKey", () => {
  it("separates spawns that differ in runtime-mode args, cwd or env", () => {
    const base = copilotPrewarmKey(spawnOf());
    expect(copilotPrewarmKey(spawnOf())).toBe(base);
    expect(copilotPrewarmKey(spawnOf({ args: ["--acp", "--allow-all-tools"] }))).not.toBe(base);
    expect(copilotPrewarmKey(spawnOf({ cwd: "/other" }))).not.toBe(base);
    expect(copilotPrewarmKey(spawnOf({ env: { A: "2" } }))).not.toBe(base);
  });

  it("ignores env ordering so equivalent spawns share a warmed process", () => {
    const left = copilotPrewarmKey(spawnOf({ env: { A: "1", B: "2" } }));
    const right = copilotPrewarmKey(spawnOf({ env: { B: "2", A: "1" } }));
    expect(left).toBe(right);
  });
});

describe("CopilotSessionPrewarmPool", () => {
  it("hands the warmed runtime to a matching acquire", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf()));
      const acquired = yield* pool.acquire(spawnOf());

      expect(acquired).toBeDefined();
      expect(processes).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("refuses a warmed process spawned for a different identity", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf({ cwd: "/repo" })));
      const acquired = yield* pool.acquire(spawnOf({ cwd: "/elsewhere" }));

      expect(acquired).toBeUndefined();
      // The unusable process is torn down rather than left idle forever.
      expect(processes[0]?.closed).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("discards a warmed process whose child died", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf()));
      processes[0]!.alive = false;

      expect(yield* pool.acquire(spawnOf())).toBeUndefined();
      expect(processes[0]?.closed).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("discards a warmed process past its TTL", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf()));
      yield* TestClock.adjust(Duration.millis(COPILOT_PREWARM_TTL_MS + 1));

      expect(yield* pool.acquire(spawnOf())).toBeUndefined();
      expect(processes[0]?.closed).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise));

  it("only serves a warmed process once", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf()));

      expect(yield* pool.acquire(spawnOf())).toBeDefined();
      expect(yield* pool.acquire(spawnOf())).toBeUndefined();
      expect(processes).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("transfers ownership so the acquiring scope closes the process", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));
      yield* pool.prewarm(requestOf(spawnOf()));

      const sessionScope = yield* Scope.make("sequential");
      yield* pool.acquire(spawnOf()).pipe(Effect.provideService(Scope.Scope, sessionScope));

      expect(processes[0]?.closed).toBe(false);
      yield* Scope.close(sessionScope, Exit.void);
      expect(processes[0]?.closed).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("keeps at most one idle process, replacing a stale spawn identity", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf({ cwd: "/one" })));
      yield* pool.prewarm(requestOf(spawnOf({ cwd: "/two" })));

      expect(processes).toHaveLength(2);
      expect(processes[0]?.closed).toBe(true);
      expect(processes[1]?.closed).toBe(false);
      expect(yield* pool.acquire(spawnOf({ cwd: "/two" }))).toBeDefined();
    }).pipe(Effect.scoped, Effect.runPromise));

  it("reuses the live warmed process instead of respawning on repeat prewarms", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes));

      yield* pool.prewarm(requestOf(spawnOf()));
      yield* pool.prewarm(requestOf(spawnOf()));
      yield* pool.prewarm(requestOf(spawnOf()));

      expect(processes).toHaveLength(1);
      expect(processes[0]?.closed).toBe(false);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("never fails the caller when warmup fails, and leaves the slot empty", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const pool = yield* makeCopilotSessionPrewarmPool(() =>
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(new Error("copilot binary missing"))),
        ),
      );

      yield* pool.prewarm(requestOf(spawnOf()));

      expect(yield* Ref.get(attempts)).toBe(1);
      expect(yield* pool.acquire(spawnOf())).toBeUndefined();
    }).pipe(Effect.scoped, Effect.runPromise));

  it("closes an idle warmed process when the owning scope shuts down", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const poolScope = yield* Scope.make("sequential");

      const pool = yield* makeCopilotSessionPrewarmPool(makeFakeBuilder(processes)).pipe(
        Effect.provideService(Scope.Scope, poolScope),
      );
      yield* pool.prewarm(requestOf(spawnOf()));
      expect(processes[0]?.closed).toBe(false);

      yield* Scope.close(poolScope, Exit.void);
      expect(processes[0]?.closed).toBe(true);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("does not let a stalled warmup block acquisition", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      // A warmup that never resolves, standing in for a hung `initialize` or
      // `authenticate` against a live-but-unresponsive agent process.
      const pool = yield* makeCopilotSessionPrewarmPool(() =>
        Ref.update(started, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      );

      yield* pool.prewarm(requestOf(spawnOf())).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(started)).toBe(1);

      // Must fall back to a cold start rather than wait on the stalled build.
      const acquired = yield* pool
        .acquire(spawnOf())
        .pipe(Effect.timeout(Duration.seconds(5)), Effect.scoped);
      expect(acquired).toBeUndefined();
    }).pipe(Effect.scoped, Effect.runPromise));

  it("abandons and tears down a warmup that exceeds the timeout", () =>
    Effect.gen(function* () {
      const processes: Array<FakeProcess> = [];
      const build = makeFakeBuilder(processes);
      const pool = yield* makeCopilotSessionPrewarmPool((request) =>
        build(request).pipe(Effect.andThen(Effect.never)),
      );

      const fiber = yield* pool.prewarm(requestOf(spawnOf())).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(COPILOT_PREWARM_WARMUP_TIMEOUT_MS + 1));
      yield* Fiber.await(fiber);

      expect(processes[0]?.closed).toBe(true);
      expect(yield* pool.acquire(spawnOf())).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise));

  it("does not start a second build while one is already in flight", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const pool = yield* makeCopilotSessionPrewarmPool(() =>
        Ref.update(started, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      );

      yield* pool.prewarm(requestOf(spawnOf())).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* pool.prewarm(requestOf(spawnOf({ cwd: "/other" })));
      yield* pool.prewarm(requestOf(spawnOf()));

      expect(yield* Ref.get(started)).toBe(1);
    }).pipe(Effect.scoped, Effect.runPromise));
});
