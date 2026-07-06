import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { PluginInstaller } from "./PluginInstaller.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import { PluginManagementRpcHandlers } from "./PluginManagementRpcHandlers.ts";
import * as PluginManagementRpcHandlersModule from "./PluginManagementRpcHandlers.ts";
import * as PluginMarketplace from "./PluginMarketplace.ts";

const pluginId = PluginId.make("test-plugin");

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
  ),
);

const InstallerMockLive = Layer.succeed(
  PluginInstaller,
  PluginInstaller.of({
    beginInstall: () => Effect.die("not used"),
    confirmInstall: () => Effect.die("not used"),
    abortInstall: () => Effect.void,
    setEnabled: () => Effect.void,
    uninstall: () => Effect.void,
    beginUpgrade: () => Effect.die("not used"),
    confirmUpgrade: () => Effect.die("not used"),
    checkUpdates: Effect.succeed({ updates: [] }),
  }),
);

const managementTest = it.layer(
  PluginManagementRpcHandlersModule.layer.pipe(
    Layer.provideMerge(PluginLockfileStoreLayer.layer),
    Layer.provideMerge(PluginMarketplace.layer),
    Layer.provideMerge(InstallerMockLive),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-management-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

managementTest("PluginManagementRpcHandlers", (it) => {
  it.effect("dedupes added sources by normalized HTTPS URL", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;

      const first = yield* handlers.addSource({
        url: "https://example.test/marketplace.json#ignored",
      });
      const second = yield* handlers.addSource({
        url: "https://example.test/marketplace.json",
      });
      const listed = yield* handlers.listSources;

      assert.equal(first.source.id, second.source.id);
      assert.equal(listed.sources.length, 1);
      assert.equal(listed.sources[0]?.url, "https://example.test/marketplace.json");
    }),
  );

  it.effect("rejects non-HTTPS sources", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;

      const result = yield* Effect.result(handlers.addSource({ url: "http://example.test" }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-source");
    }),
  );

  it.effect("prevents removing a source used by an installed plugin", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;
      const store = yield* PluginLockfileStore;
      const source = yield* handlers.addSource({ url: "https://example.test/marketplace.json" });
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "sha",
          sourceId: source.source.id,
          enabled: true,
          state: "active",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const result = yield* Effect.result(handlers.removeSource({ sourceId: source.source.id }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-source");
    }),
  );
});
