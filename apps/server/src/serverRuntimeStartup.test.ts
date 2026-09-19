import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerActivation from "./serverActivation.ts";
import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

// Stepping scheduler (mirrors ProviderSessionManager.test.ts): counts op
// boundaries per fiber and can hold the first spawned fiber reaching an armed
// offset, parking its resume task until `resumeSpawned` requeues it. Used to
// land an interrupt inside an otherwise unschedulable fork/record gap.
function makeSteppingScheduler() {
  const tasks: Array<() => void> = [];
  const counts = new Map<Fiber.Fiber<unknown, unknown>, number>();
  const targets = new Map<Fiber.Fiber<unknown, unknown>, number>();
  const held = new Map<Fiber.Fiber<unknown, unknown>, () => void>();
  let spawnedTarget: number | undefined;
  let capture: Fiber.Fiber<unknown, unknown> | undefined;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      const count = (counts.get(fiber) ?? 0) + 1;
      counts.set(fiber, count);
      if (targets.has(fiber)) return count === targets.get(fiber);
      if (spawnedTarget === undefined || count !== spawnedTarget) return false;
      spawnedTarget = undefined;
      capture = fiber;
      return true;
    },
    makeDispatcher: () => ({
      scheduleTask: (task) => {
        if (capture !== undefined) {
          held.set(capture, task);
          capture = undefined;
          return;
        }
        tasks.push(task);
      },
      flush: () => {
        while (tasks.length > 0) tasks.shift()!();
      },
    }),
  };
  const drain = Effect.gen(function* () {
    for (let round = 0; round < 64; round++) {
      while (tasks.length > 0) tasks.shift()!();
      yield* Effect.yieldNow;
      if (tasks.length === 0) return;
    }
  });
  const holdSpawnedAt = (ops: number) => {
    spawnedTarget = ops;
  };
  const resumeSpawned = () => {
    for (const task of held.values()) tasks.push(task);
    held.clear();
  };
  return { scheduler, drain, holdSpawnedAt, resumeSpawned };
}

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), ["import", "recover", "worker", "bootstrap"]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("bounds the worker stop wait when a stalled worker cannot honour the interrupt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      // The worker sits in an uninterruptible region forever, like a stalled
      // adapter acquisition, so its interrupt signal can never be honoured.
      // The stop wait must still resolve so teardown can continue. The worker
      // is scoped: hand the call a scope that is never closed so the
      // uninterruptible fiber cannot pin test teardown.
      const leakedScope = yield* Scope.make();
      const call = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.uninterruptible),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit, Effect.provideService(Scope.Scope, leakedScope), Effect.forkDetach);

      // Drive the clock until the bounded stop wait fires and the call exits;
      // an unbounded wait on the stalled worker never would.
      while (call.pollUnsafe() === undefined) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust("31 seconds");
      }

      const exit = yield* Fiber.join(call);
      assert.isTrue(Exit.isFailure(exit));
    }),
  ),
);

it.effect("scope close reaches teardown past a stalled uninterruptible worker", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
    // Stands in for providerSessions.shutdown: registered before the worker is
    // forked, so it runs after the worker's own scope finalizer on close.
    const teardownRan = yield* Ref.make(false);
    yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Ref.set(teardownRan, true));
      yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.uninterruptible),
        startRelay: Effect.void,
        workerFiberRef,
      });
    }).pipe(Effect.provideService(Scope.Scope, scope));

    // A scope-bound forkScoped worker would wait on the stalled worker's exit
    // forever here; the detached worker's bounded-interrupt finalizer lets the
    // close reach the teardown finalizer.
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach);
    while (closing.pollUnsafe() === undefined) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
    }
    yield* Fiber.join(closing);
    assert.isTrue(yield* Ref.get(teardownRan));
  }),
);

it.effect("does not orphan a worker interrupted while it parks at activation", () =>
  Effect.gen(function* () {
    // Sweep the hold offset so the interrupt lands at every scheduling point
    // around the detached fork and the ownership record. Offsets that hold the
    // start fiber between the fork and `Ref.set` would orphan the worker on a
    // non-atomic sequence — the worker is released at the activation gate and
    // would then run against the closed scope.
    for (let offset = 1; offset <= 96; offset++) {
      const stepper = makeSteppingScheduler();
      const scope = yield* Scope.make();
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
      const gate = yield* Deferred.make<void>();
      const workerRan = yield* Ref.make(false);

      const start = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Ref.set(workerRan, true),
        startRelay: Effect.never,
        workerFiberRef,
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(gate)),
        Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
        Effect.forkDetach,
      );
      // Armed after the fork so the test fiber itself is never captured.
      stepper.holdSpawnedAt(offset);
      yield* stepper.drain;

      yield* Effect.sync(() => start.interruptUnsafe());
      stepper.resumeSpawned();
      yield* stepper.drain;

      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach);
      while (closing.pollUnsafe() === undefined) {
        yield* stepper.drain;
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(closing);

      yield* Deferred.succeed(gate, undefined);
      yield* stepper.drain;
      yield* Effect.yieldNow;
      assert.isFalse(yield* Ref.get(workerRan));
    }
  }),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
