import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryPersistenceError } from "./provider/Errors.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const sessionUpdatedAt = "2026-01-01T00:00:00.000Z";

function sessionThread(
  threadId: ThreadId,
  status: OrchestrationSession["status"],
  activeTurnId: TurnId | null = null,
): Pick<OrchestrationThread, "id" | "session" | "deletedAt"> {
  return {
    id: threadId,
    deletedAt: null,
    session: {
      threadId,
      status,
      providerName: "codex" as const,
      runtimeMode: "full-access" as const,
      activeTurnId,
      lastError: null,
      updatedAt: sessionUpdatedAt,
    },
  };
}

const queryWithThreads = (
  threads: ReadonlyArray<Pick<OrchestrationThread, "id" | "session" | "deletedAt">>,
) => ({ getCommandReadModel: () => Effect.succeed({ threads }) }) as never;

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

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

it.effect("reconciles provider sessions inherited from the previous server", () => {
  const threadId = ThreadId.make("thread-startup-reconcile");
  const startingThreadId = ThreadId.make("thread-startup-starting");
  const resumeCursor = { schemaVersion: 1, sessionId: "session-startup-reconcile" };
  const bindingFailure = new ProviderSessionDirectoryPersistenceError({
    operation: "ProviderSessionDirectory.getBinding",
    detail: "simulated invalid binding",
  });
  const bindingWriteFailure = new ProviderSessionDirectoryPersistenceError({
    operation: "ProviderSessionDirectory.upsert",
    detail: "simulated binding write failure",
  });
  const upserts: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
  const dispatches: Array<OrchestrationCommand> = [];

  return ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads([
        {
          ...sessionThread(threadId, "running", TurnId.make("turn-startup-reconcile")),
          deletedAt: "2026-01-02T00:00:00.000Z",
        },
        sessionThread(startingThreadId, "starting"),
        sessionThread(ThreadId.make("thread-startup-ready"), "ready"),
      ]),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: (candidate: ThreadId) =>
        candidate === threadId
          ? Effect.succeed(
              Option.some({
                threadId,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                status: "running",
                resumeCursor,
              }),
            )
          : Effect.fail(bindingFailure),
      upsert: (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
        Effect.sync(() => upserts.push(binding)).pipe(
          Effect.andThen(Effect.fail(bindingWriteFailure)),
        ),
    } satisfies Partial<ProviderSessionDirectory.ProviderSessionDirectory["Service"]> as never),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => dispatches.push(command)).pipe(Effect.as({ sequence: 1 })),
    } satisfies Partial<OrchestrationEngine.OrchestrationEngineService["Service"]> as never),
    Effect.provide(NodeServices.layer),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(upserts.length, 1);
        assert.equal(upserts[0]?.status, "stopped");
        assert.deepStrictEqual(upserts[0]?.resumeCursor, resumeCursor);
        assert.deepStrictEqual(upserts[0]?.runtimePayload, { activeTurnId: null });

        assert.equal(dispatches.length, 2);
        const command = dispatches[0];
        assert.equal(command?.type, "thread.session.set");
        if (command?.type === "thread.session.set") {
          assert.equal(command.threadId, threadId);
          assert.equal(command.session.status, "stopped");
          assert.equal(command.session.activeTurnId, null);
          assert.notEqual(command.session.updatedAt, sessionUpdatedAt);
          assert.equal(command.session.updatedAt, command.createdAt);
        }
        const startingCommand = dispatches[1];
        assert.equal(startingCommand?.type, "thread.session.set");
        if (startingCommand?.type === "thread.session.set") {
          assert.equal(startingCommand.threadId, startingThreadId);
        }
      }),
    ),
  );
});

it.effect("fails startup reconciliation when a session cannot be settled", () => {
  const threadId = ThreadId.make("thread-startup-reconcile-failure");
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated reconciliation failure",
  });

  return ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads([
        sessionThread(threadId, "running", TurnId.make("turn-startup-reconcile-failure")),
      ]),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: () => Effect.succeed(Option.none()),
    } satisfies Partial<ProviderSessionDirectory.ProviderSessionDirectory["Service"]> as never),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: () => Effect.fail(failure),
    } satisfies Partial<OrchestrationEngine.OrchestrationEngineService["Service"]> as never),
    Effect.provide(NodeServices.layer),
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.equal(error, failure))),
  );
});

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
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
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
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

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
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
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
