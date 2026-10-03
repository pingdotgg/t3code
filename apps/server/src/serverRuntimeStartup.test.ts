import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COPILOT_DRIVER_KIND,
  defaultInstanceIdForDriver,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";

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
  resolveListeningLocalOrigin,
  retryConnectReconciliation,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

it.effect("targets the listening address family and actual port for Connect", () =>
  Effect.gen(function* () {
    for (const [hostname, expected] of [
      ["0.0.0.0", "http://127.0.0.1:43123"],
      ["127.0.0.1", "http://127.0.0.1:43123"],
      ["::", "http://[::1]:43123"],
      ["[::]", "http://[::1]:43123"],
      ["::1", "http://[::1]:43123"],
      ["[::1]", "http://[::1]:43123"],
      ["localhost", "http://localhost:43123"],
    ]) {
      const origin = yield* resolveListeningLocalOrigin.pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: { _tag: "TcpAddress", hostname: hostname!, port: 43123 },
            serve: () => Effect.void,
          }),
        ),
      );
      assert.equal(origin, expected);
    }
  }),
);

it.effect("rejects interface binds that Connect link proofs cannot authorize", () =>
  Effect.gen(function* () {
    for (const hostname of ["192.168.1.20", "2001:db8::1", "[fe80::1]", "127.0.0.2"]) {
      const error = yield* resolveListeningLocalOrigin.pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: { _tag: "TcpAddress", hostname, port: 43123 },
            serve: () => Effect.void,
          }),
        ),
        Effect.flip,
      );
      assert.include(error.message, "explicit interface bind is unsupported");
      assert.include(error.message, "--host 127.0.0.1");
      assert.include(error.message, "--host 0.0.0.0");
    }
  }),
);

it.effect("does not invent a localhost endpoint for a Unix socket listener", () =>
  Effect.gen(function* () {
    const error = yield* resolveListeningLocalOrigin.pipe(
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: { _tag: "UnixAddress", path: "/tmp/t3.sock" },
          serve: () => Effect.void,
        }),
      ),
      Effect.flip,
    );
    assert.include(error.message, "requires a TCP listener");
  }),
);

it.each([
  ["0.0.0.0", "::"],
  ["127.0.0.1", "::1"],
])("keeps %s and %s environments distinct through the Node HTTP adapter", (ipv4, ipv6) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") throw new Error("Expected a TCP listener");
      const port = server.address.port;
      const ipv4Origin = yield* resolveListeningLocalOrigin;
      assert.equal(ipv4Origin, `http://127.0.0.1:${port}`);
      yield* Effect.gen(function* () {
        const ipv6Server = yield* HttpServer.HttpServer;
        assert.equal(HttpServer.formatAddress(ipv6Server.address), `http://[${ipv6}]:${port}`);
        const ipv6Origin = yield* resolveListeningLocalOrigin;
        assert.equal(ipv6Origin, `http://[::1]:${port}`);
        for (const [origin, environment] of [
          [ipv4Origin, "desktop-environment"],
          [ipv6Origin, "other-environment"],
        ]) {
          const identity = yield* Effect.promise(async () => {
            const response = await fetch(`${origin}/.well-known/t3/environment`, {
              signal: AbortSignal.timeout(2_000),
            });
            return response.text();
          });
          assert.equal(identity, environment);
        }
      }).pipe(
        Effect.provide(
          NodeHttpServer.layer(
            () => createServer((_request, response) => response.end("other-environment")),
            { host: ipv6, port, ipv6Only: true },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        NodeHttpServer.layer(
          () => createServer((_request, response) => response.end("desktop-environment")),
          { host: ipv4, port: 0 },
        ),
      ),
    ),
  ),
);

it("defaults auto-bootstrapped selection to gpt-6-luna on low reasoning", () => {
  assert.deepStrictEqual(getAutoBootstrapDefaultModelSelection(), {
    instanceId: defaultInstanceIdForDriver(COPILOT_DRIVER_KIND),
    model: "gpt-6-luna",
    options: [{ id: "reasoning", value: "low" }],
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
          getActiveChatArchiveEntries: () => Effect.die("unused"),
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
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
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
        getActiveChatArchiveEntries: () => Effect.die("unused"),
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
        getThreadDetailSnapshotById: () => Effect.die("unused"),
        listThreadProjectIds: () => Effect.die("unused"),
        getThreadActivitiesPage: () => Effect.die("unused"),
        readThread: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        withWorktreeLock: (effect) => effect,
        streamDomainEvents: Stream.empty,
        // Unused by these tests; Effect.never satisfies the scoped subscription type.
        acquireDomainEventSubscription: Effect.never,
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
        getActiveChatArchiveEntries: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadShellProjectContextById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshotById: () => Effect.die("unused"),
        listThreadProjectIds: () => Effect.die("unused"),
        getThreadActivitiesPage: () => Effect.die("unused"),
        readThread: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        withWorktreeLock: (effect) => effect,
        streamDomainEvents: Stream.empty,
        // Unused by these tests; Effect.never satisfies the scoped subscription type.
        acquireDomainEventSubscription: Effect.never,
      } satisfies OrchestrationEngineShape),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);
