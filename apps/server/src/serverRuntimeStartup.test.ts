import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "./config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  getAutoBootstrapDefaultModelSelection,
  launchStartupHeartbeat,
  makeCommandGate,
  resolveAutoBootstrapWelcomeTargets,
  resolveWelcomeBase,
  retryConnectReconciliation,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("retryConnectReconciliation retries at one and three seconds before succeeding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const result = yield* retryConnectReconciliation(
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt < 3 ? Effect.fail(`failure-${attempt}`) : Effect.succeed("connected"),
          ),
        ),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(attempts), 1);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Ref.get(attempts), 2);
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* Fiber.join(result), "connected");
      assert.equal(yield* Ref.get(attempts), 3);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retryConnectReconciliation returns the third failure without another sleep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const result = yield* Effect.result(
        retryConnectReconciliation(
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) => Effect.fail(`failure-${attempt}`)),
          ),
        ),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("3 seconds");
      const exit = yield* Fiber.join(result);
      assert.equal(yield* Ref.get(attempts), 3);
      assert.deepInclude(exit, {
        _tag: "Failure",
        failure: "failure-3",
      });
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadActivitiesPage: () => Effect.die("unused"),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadShellProjectContextById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadActivitiesPage: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
      } satisfies OrchestrationEngineShape),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadShellProjectContextById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadActivitiesPage: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
      } satisfies OrchestrationEngineShape),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);
