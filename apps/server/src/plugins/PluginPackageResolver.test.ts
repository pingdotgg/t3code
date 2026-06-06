import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  discoverPluginPackage,
  loadPluginPackage,
  PluginPackageResolver,
  PluginPackageResolverLive,
} from "./PluginPackageResolver.ts";

const platformLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-resolver-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const layer = it.layer(
  Layer.mergeAll(PluginPackageResolverLive.pipe(Layer.provide(platformLayer)), platformLayer),
);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const FIXTURE_PLUGIN_ID = "t3.test";
const FIXTURE_PACKAGE_NAME = "@t3tools/plugin-test";

function writePluginPackage(input: { readonly packageRoot: string; readonly manifest: unknown }) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(input.packageRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(input.packageRoot, "package.json"),
      yield* encodeUnknownJsonString({
        name: FIXTURE_PACKAGE_NAME,
        version: "0.0.1",
        t3Plugin: {
          id: FIXTURE_PLUGIN_ID,
          apiVersion: "^0.0.24",
          manifest: "./manifest.json",
          server: "./server.js",
          client: "./client.js",
        },
      }),
    );
    yield* fs.writeFileString(
      path.join(input.packageRoot, "manifest.json"),
      yield* encodeUnknownJsonString(input.manifest),
    );
    yield* fs.writeFileString(path.join(input.packageRoot, "client.js"), "");
  });
}

function writeImportablePluginPackage(input: {
  readonly packageRoot: string;
  readonly manifest: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly routes: ReadonlyArray<unknown>;
    readonly ui: { readonly placements: ReadonlyArray<unknown> };
    readonly commands: ReadonlyArray<unknown>;
  };
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* writePluginPackage(input);
    const manifestJson = yield* encodeUnknownJsonString(input.manifest);
    yield* fs.writeFileString(
      path.join(input.packageRoot, "server.js"),
      `export default {
  manifest: ${manifestJson},
  activate() {
    throw new Error("PluginPackageResolver test fixture activation is not expected.");
  },
};
`,
    );
  });
}

layer("PluginPackageResolver", (it) => {
  it.effect("discovers importable package entries from a plugins directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const resolver = yield* PluginPackageResolver;
      const pluginsDir = path.join(config.baseDir, "plugins");
      const packageRoot = path.join(pluginsDir, FIXTURE_PLUGIN_ID);
      const manifest = {
        id: FIXTURE_PLUGIN_ID,
        name: "Fixture",
        version: "0.0.1",
        routes: [{ id: "main", label: "Fixture", surface: "app" }],
        ui: { placements: [] },
        commands: [],
      };

      yield* fs.makeDirectory(pluginsDir, { recursive: true });
      yield* writeImportablePluginPackage({ packageRoot, manifest });

      const results = yield* resolver.discoverFromDirectory(pluginsDir);
      const result = results[0];

      assert.equal(results.length, 1);
      assert.equal(result?.status, "loaded");
      if (result?.status !== "loaded") return;
      const plugin = result.plugin;
      assert.equal(plugin?.manifest.id, PluginId.make(FIXTURE_PLUGIN_ID));
      assert.equal(plugin?.descriptor.pluginId, PluginId.make(FIXTURE_PLUGIN_ID));
      assert.equal(plugin?.descriptor.packageName, FIXTURE_PACKAGE_NAME);
      assert.equal(plugin?.descriptor.packageRoot, packageRoot);
      assert.equal(plugin?.manifest.name, "Fixture");
      assert.isFunction(plugin?.serverPlugin.activate);
      assert.isTrue(plugin?.descriptor.clientEntryPath.endsWith("client.js"));
    }),
  );

  it.effect("normalizes duplicate plugin ids into discovery failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* PluginPackageResolver;
      const pluginsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-plugin-resolver-duplicate-plugin-id-",
      });
      const manifest = {
        id: FIXTURE_PLUGIN_ID,
        name: "Fixture",
        version: "0.0.1",
        routes: [{ id: "main", label: "Fixture", surface: "app" }],
        ui: { placements: [] },
        commands: [],
      };

      yield* writeImportablePluginPackage({
        packageRoot: path.join(pluginsDir, "first"),
        manifest,
      });
      yield* writeImportablePluginPackage({
        packageRoot: path.join(pluginsDir, "second"),
        manifest,
      });

      const results = yield* resolver.discoverFromDirectory(pluginsDir);

      assert.equal(results.length, 2);
      assert.deepEqual(
        results.map((result) => result.status),
        ["discovery-failed", "discovery-failed"],
      );
      for (const result of results) {
        if (result.status !== "discovery-failed") continue;
        assert.equal(result.plugin.discovery.pluginId, PluginId.make(FIXTURE_PLUGIN_ID));
        assert.include(result.diagnostic, "Duplicate plugin id");
      }
    }),
  );

  it.effect("reports unloadable package entries without failing discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* PluginPackageResolver;
      const pluginsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-plugin-resolver-invalid-",
      });
      const packageRoot = path.join(pluginsDir, "bad-plugin");

      yield* writePluginPackage({
        packageRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: { placements: [] },
          commands: [],
        },
      });

      const results = yield* resolver.discoverFromDirectory(pluginsDir);
      const result = results[0];

      assert.equal(results.length, 1);
      assert.equal(result?.status, "failed");
      if (result?.status !== "failed") return;
      assert.equal(result.plugin.manifest.id, PluginId.make("t3.test"));
      assert.include(result.diagnostic, "server entry file could not be found");
    }),
  );

  it.effect("classifies unreadable package JSON as package-root-only discovery failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageRoot = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-resolver-bad-package-json-" }),
        "plugin",
      );
      yield* fs.makeDirectory(packageRoot, { recursive: true });
      yield* fs.writeFileString(path.join(packageRoot, "package.json"), "{not-json");

      const result = yield* discoverPluginPackage(packageRoot);

      assert.equal(result.status, "discovery-failed");
      if (result.status !== "discovery-failed") return;
      assert.equal(result.plugin.discovery.packageRoot, packageRoot);
      assert.isUndefined(result.plugin.discovery.pluginId);
      assert.include(result.diagnostic, "could not be parsed");
    }),
  );

  it.effect("classifies invalid manifests as descriptor-backed discovery failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageRoot = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-resolver-bad-manifest-" }),
        "plugin",
      );
      yield* writePluginPackage({
        packageRoot,
        manifest: {
          id: "not matching package id",
          name: "Test",
          version: "0.0.1",
          routes: [],
          ui: { placements: [] },
          commands: [],
        },
      });

      const result = yield* discoverPluginPackage(packageRoot);

      assert.equal(result.status, "discovery-failed");
      if (result.status !== "discovery-failed") return;
      assert.equal(result.plugin.discovery.pluginId, PluginId.make("t3.test"));
      assert.equal(result.plugin.discovery.packageName, "@t3tools/plugin-test");
      assert.equal(result.plugin.discovery.packageRoot, packageRoot);
      assert.include(result.diagnostic, "does not match the plugin manifest schema");
    }),
  );

  it.effect("rejects legacy top-level nav manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageRoot = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-resolver-legacy-nav-" }),
        "plugin",
      );
      yield* writePluginPackage({
        packageRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          nav: [{ id: "main", label: "Test", routeId: "main" }],
          commands: [],
        },
      });

      const result = yield* Effect.flip(loadPluginPackage(packageRoot));
      assert.include(result.message, "legacy top-level nav");
    }),
  );

  it.effect("rejects duplicate route and placement ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-plugin-resolver-duplicate-ids-",
      });
      const duplicateRoutesRoot = path.join(root, "duplicate-routes");
      const duplicatePlacementsRoot = path.join(root, "duplicate-placements");

      yield* writePluginPackage({
        packageRoot: duplicateRoutesRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [
            { id: "main", label: "Test", surface: "app" },
            { id: "main", label: "Duplicate", surface: "app" },
          ],
          ui: { placements: [] },
          commands: [],
        },
      });
      const duplicateRouteResult = yield* Effect.flip(loadPluginPackage(duplicateRoutesRoot));
      assert.include(duplicateRouteResult.message, "duplicate route id");

      yield* writePluginPackage({
        packageRoot: duplicatePlacementsRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: {
            placements: [
              {
                id: "main-sidebar",
                position: "sidebar.primary",
                label: "Test",
                routeId: "main",
              },
              {
                id: "main-sidebar",
                position: "sidebar.footer",
                label: "Test Footer",
                routeId: "main",
              },
            ],
          },
          commands: [],
        },
      });
      const duplicatePlacementResult = yield* Effect.flip(
        loadPluginPackage(duplicatePlacementsRoot),
      );
      assert.include(duplicatePlacementResult.message, "duplicate placement id");

      const duplicateComposerActionsRoot = path.join(root, "duplicate-composer-actions");
      yield* writePluginPackage({
        packageRoot: duplicateComposerActionsRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: {
            placements: [],
            composerActions: [
              {
                id: "voice",
                position: "composer.footer.left",
                label: "Voice",
              },
              {
                id: "voice",
                position: "composer.footer.left",
                label: "Duplicate Voice",
              },
            ],
          },
          commands: [],
        },
      });
      const duplicateComposerActionResult = yield* Effect.flip(
        loadPluginPackage(duplicateComposerActionsRoot),
      );
      assert.include(duplicateComposerActionResult.message, "duplicate composer action id");
    }),
  );

  it.effect("rejects server commands marked as keybinding commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageRoot = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-resolver-keybinding-target-" }),
        "plugin",
      );
      yield* writePluginPackage({
        packageRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: { placements: [] },
          commands: [
            {
              name: "testServerCommand",
              target: "server",
              label: "Server Command",
              keybinding: true,
            },
          ],
        },
      });

      const result = yield* Effect.flip(loadPluginPackage(packageRoot));
      assert.include(result.message, "does not match the plugin manifest schema");

      const dottedCommandRoot = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-resolver-keybinding-dotted-" }),
        "plugin",
      );
      yield* writePluginPackage({
        packageRoot: dottedCommandRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: { placements: [] },
          commands: [
            {
              name: "test.client.command",
              target: "client",
              label: "Client Command",
              keybinding: true,
            },
          ],
        },
      });

      const dottedResult = yield* Effect.flip(loadPluginPackage(dottedCommandRoot));
      assert.include(dottedResult.message, "does not match the plugin manifest schema");
    }),
  );

  it.effect("rejects placements that reference missing or incompatible routes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-plugin-resolver-placement-routes-",
      });
      const missingRouteRoot = path.join(root, "missing-route");
      const sidebarSettingsRoot = path.join(root, "sidebar-settings");
      const settingsAppRoot = path.join(root, "settings-app");

      yield* writePluginPackage({
        packageRoot: missingRouteRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: {
            placements: [
              {
                id: "missing",
                position: "sidebar.primary",
                label: "Missing",
                routeId: "missing",
              },
            ],
          },
          commands: [],
        },
      });
      const missingRouteResult = yield* Effect.flip(loadPluginPackage(missingRouteRoot));
      assert.include(missingRouteResult.message, "references missing route");

      yield* writePluginPackage({
        packageRoot: sidebarSettingsRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "settings", label: "Test", surface: "settings" }],
          ui: {
            placements: [
              {
                id: "sidebar",
                position: "sidebar.primary",
                label: "Sidebar",
                routeId: "settings",
              },
            ],
          },
          commands: [],
        },
      });
      const sidebarSettingsResult = yield* Effect.flip(loadPluginPackage(sidebarSettingsRoot));
      assert.include(sidebarSettingsResult.message, "must target an app route");

      yield* writePluginPackage({
        packageRoot: settingsAppRoot,
        manifest: {
          id: "t3.test",
          name: "Test",
          version: "0.0.1",
          routes: [{ id: "main", label: "Test", surface: "app" }],
          ui: {
            placements: [
              {
                id: "settings",
                position: "settings.sidebar",
                label: "Settings",
                routeId: "main",
              },
            ],
          },
          commands: [],
        },
      });
      const settingsAppResult = yield* Effect.flip(loadPluginPackage(settingsAppRoot));
      assert.include(settingsAppResult.message, "must target a settings route");
    }),
  );
});
