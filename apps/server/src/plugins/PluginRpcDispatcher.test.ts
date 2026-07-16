import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  pluginReadScope,
  type AuthScope,
} from "@t3tools/contracts";
import { PluginId, PluginManifest, type PluginLockfilePlugin } from "@t3tools/contracts/plugin";
import type { PluginRegistration } from "@t3tools/plugin-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { pluginManifestPath, pluginVersionDir } from "./PluginPaths.ts";
import * as PluginCatalogModule from "./PluginCatalog.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import * as PluginLockfileStoreModule from "./PluginLockfileStore.ts";
import { PluginRpcDispatcher } from "./PluginRpcDispatcher.ts";
import * as PluginRpcDispatcherModule from "./PluginRpcDispatcher.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";
import * as PluginRuntimeRegistryModule from "./PluginRuntimeRegistry.ts";

const pluginId = PluginId.make("test-plugin");
const failedPluginId = PluginId.make("failed-plugin");
const encodeManifestJson = Schema.encodeSync(Schema.fromJsonString(PluginManifest));

const manifest = (id = pluginId): PluginManifest => ({
  id,
  name: id === pluginId ? "Test Plugin" : "Failed Plugin",
  version: "1.0.0",
  hostApi: "^1.0.0",
  capabilities: ["agents"],
  entries: { server: "server.js", web: "web/index.js" },
});

const makeLockfilePlugin = (
  overrides: Partial<PluginLockfilePlugin> = {},
): PluginLockfilePlugin => ({
  version: "1.0.0",
  sha256: "sha",
  sourceId: "local",
  enabled: true,
  state: "active",
  activation: { activatingSince: null, crashCount: 0 },
  installedAt: "2026-07-03T00:00:00.000Z",
  lastError: null,
  ...overrides,
});

const session = (scopes: ReadonlyArray<AuthScope>) => ({ scopes });

const registration: PluginRegistration = {
  rpc: [
    {
      method: "echo",
      scope: "read",
      handler: (payload, ctx) => Effect.succeed({ pluginId: ctx.pluginId, payload }),
    },
    {
      method: "operate",
      scope: "operate",
      handler: () => Effect.succeed("operated"),
    },
    {
      method: "pre-ready",
      scope: "read",
      readiness: "always",
      handler: () => Effect.succeed("pre-ready"),
    },
    {
      method: "defect",
      scope: "read",
      readiness: "always",
      handler: () => Effect.die(new Error("boom")),
    },
    {
      method: "hang",
      scope: "read",
      readiness: "always",
      handler: () => Effect.never,
    },
  ],
  streams: [
    {
      method: "events",
      scope: "read",
      handler: (payload) => Stream.make(payload, "done"),
    },
  ],
};

const dispatcherLayer = PluginRpcDispatcherModule.layer.pipe(
  Layer.provideMerge(PluginRuntimeRegistryModule.layer),
);

const dispatcherTest = it.layer(dispatcherLayer);

const putRuntime = Effect.fn("PluginRpcDispatcherTest.putRuntime")(function* (input: {
  readonly ready: boolean;
  readonly registration?: PluginRegistration;
  readonly runtimeManifest?: PluginManifest;
}) {
  const registry = yield* PluginRuntimeRegistry;
  const readiness = yield* Deferred.make<void>();
  if (input.ready) {
    yield* Deferred.succeed(readiness, undefined).pipe(Effect.orDie);
  }
  const scope = yield* Scope.make();
  yield* registry.put(pluginId, {
    manifest: input.runtimeManifest ?? manifest(),
    settings: undefined,
    registration: input.registration ?? registration,
    readiness,
    scope,
  });
});

dispatcherTest("PluginRpcDispatcher", (it) => {
  it.effect("round-trips unary calls and streams", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: true });
      const dispatcher = yield* PluginRpcDispatcher;

      const call = yield* dispatcher.call(
        pluginId,
        "echo",
        { value: 1 },
        session([pluginReadScope(pluginId)]),
      );
      const events = yield* dispatcher
        .subscribe(pluginId, "events", "first", session([pluginReadScope(pluginId)]))
        .pipe(Stream.runCollect);

      assert.deepEqual(call, { pluginId, payload: { value: 1 } });
      assert.deepEqual(events, ["first", "done"]);
    }),
  );

  it.effect("authorizes explicit plugin read grants and full standard clients", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: true });
      const dispatcher = yield* PluginRpcDispatcher;

      const explicit = yield* dispatcher.call(
        pluginId,
        "echo",
        "explicit",
        session([pluginReadScope(pluginId)]),
      );
      const implicit = yield* dispatcher.call(
        pluginId,
        "echo",
        "implicit",
        session(AuthStandardClientScopes),
      );

      assert.deepEqual(explicit, { pluginId, payload: "explicit" });
      assert.deepEqual(implicit, { pluginId, payload: "implicit" });
    }),
  );

  it.effect("rejects restricted sessions and read-only grants for operate methods", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: true });
      const dispatcher = yield* PluginRpcDispatcher;

      const restricted = yield* Effect.result(
        dispatcher.call(pluginId, "echo", null, session([AuthOrchestrationReadScope])),
      );
      const readOnlyOperate = yield* Effect.result(
        dispatcher.call(pluginId, "operate", null, session([pluginReadScope(pluginId)])),
      );

      assert.isTrue(Result.isFailure(restricted));
      assert.isTrue(Result.isFailure(readOnlyOperate));
      if (Result.isFailure(restricted)) {
        assert.equal(restricted.failure.code, "unauthorized");
      }
      if (Result.isFailure(readOnlyOperate)) {
        assert.equal(readOnlyOperate.failure.code, "unauthorized");
      }
    }),
  );

  it.effect("maps unknown plugin, unknown method, and unresolved readiness to typed errors", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: false });
      const dispatcher = yield* PluginRpcDispatcher;

      const unknownPlugin = yield* Effect.result(
        dispatcher.call(failedPluginId, "echo", null, session(AuthStandardClientScopes)),
      );
      const unknownMethod = yield* Effect.result(
        dispatcher.call(pluginId, "missing", null, session(AuthStandardClientScopes)),
      );
      const notReady = yield* Effect.result(
        dispatcher.call(pluginId, "echo", null, session(AuthStandardClientScopes)),
      );
      const preReady = yield* dispatcher.call(
        pluginId,
        "pre-ready",
        null,
        session(AuthStandardClientScopes),
      );

      assert.isTrue(Result.isFailure(unknownPlugin));
      assert.isTrue(Result.isFailure(unknownMethod));
      assert.isTrue(Result.isFailure(notReady));
      if (Result.isFailure(unknownPlugin)) assert.equal(unknownPlugin.failure.code, "not-found");
      if (Result.isFailure(unknownMethod))
        assert.equal(unknownMethod.failure.code, "invalid-method");
      if (Result.isFailure(notReady)) assert.equal(notReady.failure.code, "not-ready");
      assert.equal(preReady, "pre-ready");
    }),
  );

  it.effect("fails closed when a descriptor declares an unrecognized scope", () =>
    Effect.gen(function* () {
      // Plugin modules are untrusted, dynamically loaded JS, so a descriptor can
      // carry a scope outside the SDK's `"read" | "operate"` type (here a casing
      // typo). Such a descriptor must be REJECTED, not silently downgraded to the
      // weaker plugin read requirement.
      const badRegistration = {
        rpc: [{ method: "mystery", scope: "Operate", handler: () => Effect.succeed("nope") }],
        streams: [
          { method: "mystery-stream", scope: "Operate", handler: () => Stream.make("nope") },
        ],
      } as unknown as PluginRegistration;
      yield* putRuntime({ ready: true, registration: badRegistration });
      const dispatcher = yield* PluginRpcDispatcher;

      // Even a full standard client (which implicitly holds every plugin scope)
      // is denied — proving the rejection is on the descriptor, not the session.
      const call = yield* Effect.result(
        dispatcher.call(pluginId, "mystery", null, session(AuthStandardClientScopes)),
      );
      const stream = yield* Effect.result(
        dispatcher
          .subscribe(pluginId, "mystery-stream", null, session(AuthStandardClientScopes))
          .pipe(Stream.runCollect),
      );

      assert.isTrue(Result.isFailure(call));
      if (Result.isFailure(call)) assert.equal(call.failure.code, "unauthorized");
      assert.isTrue(Result.isFailure(stream));
      if (Result.isFailure(stream)) assert.equal(stream.failure.code, "unauthorized");
    }),
  );

  it.effect("maps handler defects to internal errors and continues serving calls", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: true });
      const dispatcher = yield* PluginRpcDispatcher;

      const defect = yield* Effect.result(
        dispatcher.call(pluginId, "defect", null, session(AuthStandardClientScopes)),
      );
      const subsequent = yield* dispatcher.call(
        pluginId,
        "echo",
        "after",
        session(AuthStandardClientScopes),
      );

      assert.isTrue(Result.isFailure(defect));
      if (Result.isFailure(defect)) {
        assert.equal(defect.failure.code, "internal");
      }
      assert.deepEqual(subsequent, { pluginId, payload: "after" });
    }),
  );
});

const shortTimeoutDispatcherLayer = Layer.effect(
  PluginRpcDispatcher,
  PluginRpcDispatcherModule.make({ handlerTimeoutMs: 100 }),
).pipe(Layer.provideMerge(PluginRuntimeRegistryModule.layer));

it.layer(shortTimeoutDispatcherLayer, {
  // Real clock: the handler deadline is a wall-clock sleep, so the default
  // TestClock (which never auto-advances) would hang the call.
  excludeTestServices: true,
})("PluginRpcDispatcher handler timeout", (it) => {
  // A hung unary handler (`Effect.never`) must not pin the WS call forever: the
  // wall-clock deadline interrupts it and surfaces a typed internal error. The
  // long-lived subscribe path is intentionally NOT bounded here.
  it.effect("fails a unary handler that exceeds the wall-clock deadline", () =>
    Effect.gen(function* () {
      yield* putRuntime({ ready: true });
      const dispatcher = yield* PluginRpcDispatcher;

      const hung = yield* Effect.result(
        dispatcher.call(pluginId, "hang", null, session(AuthStandardClientScopes)),
      );
      const fast = yield* dispatcher.call(
        pluginId,
        "echo",
        "fast",
        session(AuthStandardClientScopes),
      );

      assert.isTrue(Result.isFailure(hung));
      if (Result.isFailure(hung)) assert.equal(hung.failure.code, "internal");
      assert.deepEqual(fast, { pluginId, payload: "fast" });
    }),
  );
});

const catalogLayer = PluginCatalogModule.layer.pipe(
  Layer.provideMerge(PluginRuntimeRegistryModule.layer),
  Layer.provideMerge(PluginLockfileStoreModule.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-catalog-" })),
  Layer.provideMerge(NodeServices.layer),
);

const catalogTest = it.layer(catalogLayer);

catalogTest("PluginCatalog", (it) => {
  it.effect("lists active and failed installed plugins with state and web metadata", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* PluginLockfileStore;
      const catalog = yield* PluginCatalogModule.PluginCatalog;

      for (const pluginManifest of [manifest(pluginId), manifest(failedPluginId)]) {
        const pluginDir = pluginVersionDir(
          config.pluginsDir,
          pluginManifest.id,
          pluginManifest.version,
          path.join,
        );
        yield* fs.makeDirectory(pluginDir, { recursive: true });
        yield* fs.writeFileString(
          pluginManifestPath(pluginDir, path.join),
          encodeManifestJson(pluginManifest),
        );
      }

      yield* store.updatePlugin(pluginId, () => Effect.succeed(makeLockfilePlugin()));
      yield* store.updatePlugin(failedPluginId, () =>
        Effect.succeed(
          makeLockfilePlugin({
            state: "failed",
            lastError: "activation failed",
          }),
        ),
      );
      yield* putRuntime({
        ready: true,
        runtimeManifest: manifest(pluginId),
      });

      const plugins = yield* catalog.list;

      assert.deepEqual(
        plugins.map((plugin) => ({
          id: plugin.id,
          state: plugin.state,
          hasWeb: plugin.hasWeb,
          hasStyles: plugin.hasStyles,
          lastError: plugin.lastError,
        })),
        [
          {
            id: failedPluginId,
            state: "failed",
            hasWeb: true,
            hasStyles: false,
            lastError: "activation failed",
          },
          {
            id: pluginId,
            state: "active",
            hasWeb: true,
            hasStyles: false,
            lastError: null,
          },
        ],
      );
    }),
  );
});
