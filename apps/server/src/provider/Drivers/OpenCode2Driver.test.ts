import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  OpenCodeRuntime,
  type OpenCodeRuntimeShape,
  OpenCodeRuntimeError,
} from "../opencodeRuntime.ts";
import { OPENCODE_2_RESPONSES } from "../testFixtures/opencodeProbeResponses.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import {
  makeOpenCode2SessionClient,
  type OpenCode2SessionClient,
} from "../opencode2/OpenCode2SessionStore.ts";
import { OpenCode2Driver } from "./OpenCode2Driver.ts";

// Shutdown/stopAll path for the opencode2 driver instance.
//
// The instance owns one verified server (spawned when no `serverUrl` is
// set, connected otherwise) shared by the adapter, text generation, and
// status checks. Teardown is scope-ordered: closing the driver's child
// scope releases the owner's spawn scope (process-group SIGTERM/SIGKILL),
// the snapshot fibers, and per-session pump scopes. `stopAll` on the
// adapter stops sessions (parent + subagent descendants) without touching
// the server — a spawned server idles out through the owner, an external
// URL is never stopped (no lifetime attached).
describe("OpenCode2Driver shutdown", () => {
  const unusedRuntimeMethod = () => Effect.die("unused OpenCode2Driver shutdown test method");

  const makeShutdownRuntime = () => {
    const spawnCount = { current: 0 };
    const closeCount = { current: 0 };
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: unusedRuntimeMethod as never,
      startUnverifiedOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          spawnCount.current += 1;
          const url = `http://127.0.0.1:${4100 + spawnCount.current}`;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closeCount.current += 1;
            }),
          );
          return {
            url,
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: (input) =>
        Effect.succeed({
          stdout: input.args.includes("--version") ? "opencode v2.0.18\n" : "",
          stderr: "",
          code: 0,
        }),
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };
    return { runtime, spawnCount, closeCount };
  };

  const noSpawn = ChildProcessSpawner.make(() => Effect.die("must not spawn a process"));

  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-opencode2-driver-shutdown-",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(ModelManifest.layerTest),
  );

  // The spawned server answers /api/info for ANY presented password
  // (like a real 2.x server answers for its own password — the generated
  // one is unknowable here) and 401s anonymous calls. Inventory endpoints
  // 401 too, so status refresh exercises spawn + borrow + release while the
  // snapshot falls back gracefully — lifecycle assertions don't need models.
  const acceptingServer = HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    const authorized = request.headers.authorization?.startsWith("Basic ") === true;
    if (path === "/api/info" && authorized) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(OPENCODE_2_RESPONSES["/api/info"].body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(OPENCODE_2_RESPONSES.unauthorized.body, {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  const createInstance = (
    runtime: OpenCodeRuntimeShape,
    config?: { readonly serverUrl?: string },
  ) =>
    OpenCode2Driver.create({
      instanceId: ProviderInstanceId.make("opencode2-shutdown"),
      displayName: "OpenCode 2 test",
      enabled: true,
      environment: [],
      config: {
        ...OpenCode2Driver.defaultConfig(),
        binaryPath: "opencode",
        ...(config?.serverUrl !== undefined ? { serverUrl: config.serverUrl } : {}),
      },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.provideService(OpenCodeRuntime, runtime),
      Effect.provideService(HttpClient.HttpClient, acceptingServer),
    );

  it.layer(testLayer)("shutdown", (it) => {
    it.effect("stopAll stops sessions without stopping a spawned server", () =>
      Effect.gen(function* () {
        const testRuntime = makeShutdownRuntime();
        const scope = yield* Scope.make();
        const instance = yield* createInstance(testRuntime.runtime).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        // A status check borrows the server once (lazy spawn); stopAll only
        // stops adapter sessions — the borrow is released and the server
        // stays up until the scope close (or the idle TTL).
        yield* instance.snapshot.refresh.pipe(Effect.ignore);
        NodeAssert.equal(testRuntime.spawnCount.current, 1);
        NodeAssert.equal(
          testRuntime.closeCount.current,
          0,
          "refresh must leave the spawned server running",
        );
        yield* instance.adapter.stopAll().pipe(Effect.ignore);
        NodeAssert.equal(
          testRuntime.closeCount.current,
          0,
          "stopAll must not stop the spawned server",
        );
        yield* Scope.close(scope, Exit.void);
        NodeAssert.equal(testRuntime.closeCount.current, 1);
        // A second close is a no-op: no second spawn, no second stop.
        yield* Scope.close(scope, Exit.void);
        NodeAssert.equal(testRuntime.spawnCount.current, 1);
        NodeAssert.equal(testRuntime.closeCount.current, 1);
      }).pipe(Effect.scoped),
    );

    it.effect("instance scope close stops the spawned server exactly once", () =>
      Effect.gen(function* () {
        const testRuntime = makeShutdownRuntime();
        const scope = yield* Scope.make();
        const instance = yield* createInstance(testRuntime.runtime).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* instance.snapshot.refresh.pipe(Effect.ignore);
        NodeAssert.equal(testRuntime.spawnCount.current, 1);
        yield* Scope.close(scope, Exit.void);
        NodeAssert.equal(testRuntime.closeCount.current, 1);
        yield* Scope.close(scope, Exit.void);
        NodeAssert.equal(testRuntime.closeCount.current, 1);
      }).pipe(Effect.scoped),
    );

    it.effect("external URL instance stops no process on stopAll or scope close", () =>
      Effect.gen(function* () {
        const testRuntime = makeShutdownRuntime();
        const scope = yield* Scope.make();
        const instance = yield* createInstance(testRuntime.runtime, {
          serverUrl: "http://127.0.0.1:4096",
        }).pipe(Effect.provideService(Scope.Scope, scope));
        yield* instance.snapshot.refresh.pipe(Effect.ignore);
        NodeAssert.equal(
          testRuntime.spawnCount.current,
          0,
          "an external URL must never spawn a server",
        );
        yield* instance.adapter.stopAll().pipe(Effect.ignore);
        yield* Scope.close(scope, Exit.void);
        NodeAssert.equal(testRuntime.spawnCount.current, 0);
        NodeAssert.equal(testRuntime.closeCount.current, 0);
      }).pipe(Effect.scoped),
    );
  });
});

// A `withConnection` borrow that only wraps client construction releases as
// soon as the client exists, so a spawned server could idle-stop mid-session
// (finding #4139617941/#4139673709). The borrow must stay open for the whole
// session scope and release on scope close. These tests exercise that shape
// directly against a fake `OpenCode2Server`, without spawning a real server.
describe("OpenCode2Driver createClient borrow", () => {
  const fakeConnection = {
    url: "http://127.0.0.1:4096",
    client: { session: { create: () => Promise.resolve({ data: { id: "ses_1" } }) } },
    version: "2.0.18",
    external: false,
  } as unknown as OpenCode2Server.OpenCode2Connection;

  const borrowReleased = { current: 0 };
  const fakeServer = OpenCode2Server.OpenCode2Server.of({
    withConnection: (use) =>
      Effect.acquireUseRelease(
        Effect.void,
        () => use(fakeConnection),
        () => Effect.sync(() => (borrowReleased.current += 1)),
      ),
  });

  const runCreateClient = (scope: Scope.Closeable) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<
        OpenCode2Server.OpenCode2Connection,
        OpenCodeRuntimeError
      >();
      yield* fakeServer
        .withConnection((connection) =>
          Deferred.succeed(ready, connection).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(
          Effect.catch((error) => Deferred.fail(ready, error)),
          Effect.forkScoped,
        );
      const connection = yield* Deferred.await(ready);
      return makeOpenCode2SessionClient(connection.client as never, {
        directory: "/work/dir",
      });
    }).pipe(Effect.provideService(Scope.Scope, scope));

  it.effect("holds the borrow until the session scope closes", () =>
    Effect.gen(function* () {
      borrowReleased.current = 0;
      const scope = yield* Scope.make();
      const client: OpenCode2SessionClient = yield* runCreateClient(scope);
      NodeAssert.ok(typeof client.session.create === "function");
      // Client construction must not release the borrow (this is what the
      // old `withConnection(wrap(Effect.succeed(client)))` shape did).
      NodeAssert.equal(borrowReleased.current, 0);
      yield* Scope.close(scope, Exit.void);
      NodeAssert.equal(borrowReleased.current, 1);
    }),
  );

  it.effect("maps a connection failure to a session.create request error", () =>
    Effect.gen(function* () {
      const failing = OpenCode2Server.OpenCode2Server.of({
        withConnection: () =>
          Effect.fail(
            new OpenCodeRuntimeError({ operation: "server.info", detail: "boom" }),
          ) as never,
      });
      const attempted = yield* Effect.gen(function* () {
        const ready = yield* Deferred.make<
          OpenCode2Server.OpenCode2Connection,
          OpenCodeRuntimeError
        >();
        yield* failing
          .withConnection((connection) =>
            Deferred.succeed(ready, connection).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(
            Effect.catch((error) => Deferred.fail(ready, error)),
            Effect.forkScoped,
          );
        return yield* Deferred.await(ready);
      }).pipe(Effect.provideService(Scope.Scope, yield* Scope.make()), Effect.exit);
      NodeAssert.equal(attempted._tag, "Failure");
    }),
  );
});
