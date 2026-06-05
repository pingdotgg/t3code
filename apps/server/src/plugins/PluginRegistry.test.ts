import {
  PluginCommandName,
  PluginId,
  PluginRouteId,
  PluginUiPlacementId,
  type PluginManifest,
} from "@t3tools/contracts";
import type { LoadedServerPlugin } from "@t3tools/plugin-api/package";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { pluginClientAssetUrl } from "./PluginAssets.ts";
import { PluginRegistry, PluginRegistryLive } from "./PluginRegistry.ts";

const layer = it.layer(PluginRegistryLive);

const pluginId = PluginId.make("t3.registry-test");
const routeId = PluginRouteId.make("main");
const placementId = PluginUiPlacementId.make("main-sidebar");
const command = PluginCommandName.make("registry.echo");
const manifest: PluginManifest = {
  id: pluginId,
  name: "Registry Test",
  version: "0.1.0",
  routes: [{ id: routeId, label: "Registry Test", surface: "app" }],
  ui: {
    placements: [
      {
        id: placementId,
        position: "sidebar.primary",
        label: "Registry Test",
        routeId,
      },
    ],
  },
  commands: [{ name: command, label: "Echo" }],
};

const loadedPlugin: LoadedServerPlugin = {
  manifest,
  descriptor: {
    pluginId,
    packageName: "@t3tools/plugin-registry-test",
    packageVersion: "0.1.0",
    packageRoot: "/tmp/t3-registry-test",
    apiVersion: "0.0.24",
    manifestPath: "/tmp/t3-registry-test/manifest.json",
    serverEntryPath: "/tmp/t3-registry-test/server.js",
    clientEntryPath: "/tmp/t3-registry-test/client.iife.js",
  },
  serverPlugin: {
    manifest,
    activate: () => Effect.void,
  },
};

layer("PluginRegistry", (it) => {
  it.effect("maps active plugin metadata into catalog entries and validates command I/O", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerActivePlugin(loadedPlugin);
      yield* registry.setPlacementBadgeProvider(pluginId, placementId, () => Effect.succeed(2));
      yield* registry.registerCommand(pluginId, command, {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        handler: (input) => Effect.succeed({ text: input.text.toUpperCase() }),
      });

      const catalog = yield* registry.listCatalog;
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0]?.manifest.id, pluginId);
      assert.equal(catalog[0]?.manifest.ui.placements[0]?.badgeCount, 2);
      assert.equal(catalog[0]?.assets.client, pluginClientAssetUrl(pluginId));

      const output = yield* registry.invoke(pluginId, command, {
        text: "ok",
      });
      assert.deepEqual(output, { text: "OK" });

      const invalidInput = yield* Effect.result(registry.invoke(pluginId, command, { text: 12 }));
      assert.equal(invalidInput._tag, "Failure");
      if (invalidInput._tag === "Failure") {
        assert.equal(invalidInput.failure._tag, "PluginRpcError");
        assert.equal(invalidInput.failure.command, command);
      }
    }),
  );

  it.effect("clears command and badge contributions for a plugin", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerActivePlugin(loadedPlugin);
      yield* registry.setPlacementBadgeProvider(pluginId, placementId, () => Effect.succeed(7));
      yield* registry.registerCommand(pluginId, command, {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        handler: (input) => Effect.succeed({ text: input.text }),
      });

      yield* registry.clearPluginContributions(pluginId);

      const catalog = yield* registry.listCatalog;
      assert.isUndefined(catalog[0]?.manifest.ui.placements[0]?.badgeCount);

      const invokeResult = yield* Effect.result(registry.invoke(pluginId, command, { text: "ok" }));
      assert.equal(invokeResult._tag, "Failure");
    }),
  );

  it.effect("normalizes invalid badge provider counts out of catalog entries", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerActivePlugin(loadedPlugin);
      yield* registry.setPlacementBadgeProvider(pluginId, placementId, () =>
        Effect.succeed(Number.POSITIVE_INFINITY),
      );

      const catalog = yield* registry.listCatalog;

      assert.isUndefined(catalog[0]?.manifest.ui.placements[0]?.badgeCount);
    }),
  );
});
