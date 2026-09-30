import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
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
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { OPENCODE_2_RESPONSES } from "../testFixtures/opencodeProbeResponses.ts";
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
