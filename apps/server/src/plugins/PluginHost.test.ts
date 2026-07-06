import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId, PluginManifest, type PluginLockfilePlugin } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeURL from "node:url";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PluginHostModule from "./PluginHost.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import * as PluginMigrator from "./PluginMigrator.ts";
import * as PluginModuleLoaderLayer from "./PluginModuleLoader.ts";
import { pluginDataDir, pluginVersionDir } from "./PluginPaths.ts";
import * as PluginRuntimeRegistryLayer from "./PluginRuntimeRegistry.ts";

const encodeManifestJson = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));

const testLayer = PluginHostModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayer.layer),
  Layer.provideMerge(PluginModuleLoaderLayer.layer),
  Layer.provideMerge(PluginMigrator.layer),
  Layer.provideMerge(PluginRuntimeRegistryLayer.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-host-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(testLayer);

const now = "2026-07-03T00:00:00.000Z";

const makeLockEntry = (overrides: Partial<PluginLockfilePlugin> = {}): PluginLockfilePlugin => ({
  version: "1.0.0",
  sha256: "sha",
  sourceId: "local",
  enabled: true,
  state: "active",
  activation: { activatingSince: null, crashCount: 0 },
  installedAt: now,
  lastError: null,
  ...overrides,
});

const pluginEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const Effect = require("effect/Effect");
const SqlClient = require("effect/unstable/sql/SqlClient");
const NodeFs = require("node:fs");

export default {
  register(hostApi) {
    return {
      migrations: [
        {
          version: 1,
          name: "Init",
          up: Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql\`CREATE TABLE p_test_plugin_items (id TEXT PRIMARY KEY)\`;
          }),
        },
      ],
      services: [
        {
          name: "marker",
          run: () =>
            Effect.sync(() => {
              NodeFs.writeFileSync(hostApi.config.dataDir + "/service-ran", "1");
            }).pipe(Effect.andThen(Effect.never)),
        },
      ],
    };
  },
};
`;

const installPlugin = (input: {
  readonly pluginId: PluginId;
  readonly manifestHostApi?: string;
  readonly entrySource?: string;
  readonly lockEntry?: Partial<PluginLockfilePlugin>;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
    const entry = makeLockEntry(input.lockEntry);
    const pluginDir = pluginVersionDir(config.pluginsDir, input.pluginId, entry.version, path.join);

    yield* fs.makeDirectory(pluginDir, { recursive: true });
    const encodedManifest = yield* encodeManifestJson({
      id: input.pluginId,
      name: "Test Plugin",
      version: entry.version,
      hostApi: input.manifestHostApi ?? "^1.0.0",
      capabilities: [],
      entries: { server: "server.js" },
    });
    yield* fs.writeFileString(path.join(pluginDir, "manifest.json"), encodedManifest);
    yield* fs.writeFileString(
      path.join(pluginDir, "server.js"),
      input.entrySource ?? pluginEntrySource(),
    );
    yield* store.updatePlugin(input.pluginId, () => Effect.succeed(entry));
    return { pluginDir, entry };
  });

layer("PluginModuleLoader", (it) => {
  it.effect("loads a definePlugin-shaped default export from inside the plugin dir", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("loader-plugin");
      const loader = yield* PluginModuleLoaderLayer.PluginModuleLoader;
      const { pluginDir } = yield* installPlugin({
        pluginId,
        entrySource: "export default { register() { return {}; } };",
      });

      const definition = yield* loader.loadServerEntry(pluginDir, "server.js");

      assert.equal(typeof definition.register, "function");
    }),
  );

  it.effect("rejects entries that resolve outside the plugin dir", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("loader-escape");
      const loader = yield* PluginModuleLoaderLayer.PluginModuleLoader;
      const { pluginDir } = yield* installPlugin({
        pluginId,
        entrySource: "export default { register() { return {}; } };",
      });

      const result = yield* Effect.result(loader.loadServerEntry(pluginDir, "../server.js"));

      assert.isTrue(Result.isFailure(result));
    }),
  );
});

layer("PluginHost", (it) => {
  it.effect("activates a plugin, records migrations, starts services, and clears activation", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("test-plugin");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* installPlugin({ pluginId });

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        yield* host.start;
        yield* Effect.yieldNow;
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      const runtimes = yield* registry.list;
      assert.equal(runtimes.length, 1);
      const migrationRows = yield* sql<{ readonly version: number }>`
        SELECT version FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.deepEqual(migrationRows, [{ version: 1 }]);
      assert.isTrue(
        yield* fs.exists(
          path.join(pluginDataDir(config.pluginsDir, pluginId, path.join), "service-ran"),
        ),
      );

      let lockfile = yield* store.readLockfile;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (lockfile.plugins[pluginId]?.activation.activatingSince === null) break;
        yield* Effect.yieldNow;
        lockfile = yield* store.readLockfile;
      }
      assert.equal(lockfile.plugins[pluginId]?.activation.activatingSince, null);
      assert.equal(lockfile.plugins[pluginId]?.activation.crashCount, 0);
    }),
  );

  it.effect("marks failed imports without failing host startup", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("failed-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* installPlugin({ pluginId, entrySource: "throw new Error('boom');" });

      yield* host.start;

      const runtimes = yield* registry.list;
      const lockfile = yield* store.readLockfile;
      assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === pluginId));
      assert.equal(lockfile.plugins[pluginId]?.state, "failed");
    }),
  );

  it.effect("disables crash-looping plugins before import", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("crash-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

      yield* installPlugin({
        pluginId,
        lockEntry: {
          activation: { activatingSince: now, crashCount: 1 },
        },
      });

      yield* host.start;

      const lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.state, "failed");
      assert.equal(lockfile.plugins[pluginId]?.lastError, "disabled after repeated crashes");
    }),
  );

  it.effect("does not load anything when T3_NO_PLUGINS is set", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("disabled-env");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const previous = process.env.T3_NO_PLUGINS;

      yield* installPlugin({ pluginId });
      process.env.T3_NO_PLUGINS = "1";
      try {
        yield* host.start;
      } finally {
        if (previous === undefined) {
          delete process.env.T3_NO_PLUGINS;
        } else {
          process.env.T3_NO_PLUGINS = previous;
        }
      }

      const runtimes = yield* registry.list;
      assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === pluginId));
    }),
  );

  it.effect("sets disabled-by-host when hostApi range is not satisfied", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("host-mismatch");
      const host = yield* PluginHostModule.PluginHost;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

      yield* installPlugin({ pluginId, manifestHostApi: "^2.0.0" });

      yield* host.start;

      const lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.state, "disabled-by-host");
    }),
  );

  it.effect("applies pending-remove before loading plugins", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("remove-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const { pluginDir } = yield* installPlugin({
        pluginId,
        lockEntry: { state: "pending-remove" },
      });

      yield* host.start;

      const lockfile = yield* store.readLockfile;
      assert.isUndefined(lockfile.plugins[pluginId]);
      assert.isFalse(yield* fs.exists(pluginDir));
    }),
  );
});
