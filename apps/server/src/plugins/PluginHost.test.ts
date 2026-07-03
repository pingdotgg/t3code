import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PluginId,
  PluginManifest,
  type PluginCapability,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeURL from "node:url";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProjectionThreadMessages from "../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionTurns from "../persistence/Services/ProjectionTurns.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PluginHostModule from "./PluginHost.ts";
import * as PluginHttpRegistry from "./PluginHttpRegistry.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import * as PluginMigrator from "./PluginMigrator.ts";
import * as PluginModuleLoaderLayer from "./PluginModuleLoader.ts";
import { pluginDataDir, pluginVersionDir } from "./PluginPaths.ts";
import * as PluginRuntimeRegistryLayer from "./PluginRuntimeRegistry.ts";

const encodeManifestJson = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));
const unexpectedCapabilityUse = () =>
  Effect.die(new Error("unexpected capability use in host test"));

const testLayerBase = PluginHostModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayer.layer),
  Layer.provideMerge(PluginModuleLoaderLayer.layer),
  Layer.provideMerge(PluginMigrator.layer),
  Layer.provideMerge(PluginRuntimeRegistryLayer.layer),
  Layer.provideMerge(PluginHttpRegistry.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provideMerge(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: unexpectedCapabilityUse,
      set: unexpectedCapabilityUse,
      create: unexpectedCapabilityUse,
      getOrCreateRandom: unexpectedCapabilityUse,
      remove: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: unexpectedCapabilityUse(),
      getDescriptor: unexpectedCapabilityUse(),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch: unexpectedCapabilityUse,
      streamDomainEvents: Stream.empty,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getCommandReadModel: unexpectedCapabilityUse,
      getSnapshot: unexpectedCapabilityUse,
      getShellSnapshot: unexpectedCapabilityUse,
      getArchivedShellSnapshot: unexpectedCapabilityUse,
      getSnapshotSequence: unexpectedCapabilityUse,
      getCounts: unexpectedCapabilityUse,
      getActiveProjectByWorkspaceRoot: unexpectedCapabilityUse,
      getProjectShellById: unexpectedCapabilityUse,
      getFirstActiveThreadIdByProjectId: unexpectedCapabilityUse,
      getThreadOwnerById: unexpectedCapabilityUse,
      getThreadCheckpointContext: unexpectedCapabilityUse,
      getFullThreadDiffContext: unexpectedCapabilityUse,
      getThreadShellById: unexpectedCapabilityUse,
      getThreadDetailById: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionTurns.ProjectionTurnRepository)({
      upsertByTurnId: unexpectedCapabilityUse,
      replacePendingTurnStart: unexpectedCapabilityUse,
      getPendingTurnStartByThreadId: unexpectedCapabilityUse,
      deletePendingTurnStartByThreadId: unexpectedCapabilityUse,
      listByThreadId: unexpectedCapabilityUse,
      getByTurnId: unexpectedCapabilityUse,
      clearCheckpointTurnConflict: unexpectedCapabilityUse,
      deleteByThreadId: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionThreadMessages.ProjectionThreadMessageRepository)({
      upsert: unexpectedCapabilityUse,
      getByMessageId: unexpectedCapabilityUse,
      listByThreadId: unexpectedCapabilityUse,
      deleteByThreadId: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionThreadActivities.ProjectionThreadActivityRepository)({
      upsert: unexpectedCapabilityUse,
      listByThreadId: unexpectedCapabilityUse,
      deleteByThreadId: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: unexpectedCapabilityUse,
      listInstances: unexpectedCapabilityUse(),
      listUnavailable: unexpectedCapabilityUse(),
      streamChanges: Stream.empty,
      subscribeChanges: unexpectedCapabilityUse(),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: unexpectedCapabilityUse,
      status: unexpectedCapabilityUse,
      statusDetails: unexpectedCapabilityUse,
      statusDetailsLocal: unexpectedCapabilityUse,
      statusDetailsRemote: unexpectedCapabilityUse,
      prepareCommitContext: unexpectedCapabilityUse,
      commit: unexpectedCapabilityUse,
      pushCurrentBranch: unexpectedCapabilityUse,
      readRangeContext: unexpectedCapabilityUse,
      getReviewDiffPreview: unexpectedCapabilityUse,
      readConfigValue: unexpectedCapabilityUse,
      listRefs: unexpectedCapabilityUse,
      pullCurrentBranch: unexpectedCapabilityUse,
      createWorktree: unexpectedCapabilityUse,
      fetchPullRequestBranch: unexpectedCapabilityUse,
      ensureRemote: unexpectedCapabilityUse,
      resolvePrimaryRemoteName: unexpectedCapabilityUse,
      fetchRemote: unexpectedCapabilityUse,
      resolveRemoteTrackingCommit: unexpectedCapabilityUse,
      fetchRemoteBranch: unexpectedCapabilityUse,
      fetchRemoteTrackingBranch: unexpectedCapabilityUse,
      setBranchUpstream: unexpectedCapabilityUse,
      removeWorktree: unexpectedCapabilityUse,
      renameBranch: unexpectedCapabilityUse,
      createRef: unexpectedCapabilityUse,
      switchRef: unexpectedCapabilityUse,
      initRepo: unexpectedCapabilityUse,
      listLocalBranchNames: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CheckpointStore.CheckpointStore)({
      isGitRepository: unexpectedCapabilityUse,
      captureCheckpoint: unexpectedCapabilityUse,
      hasCheckpointRef: unexpectedCapabilityUse,
      restoreCheckpoint: unexpectedCapabilityUse,
      diffCheckpoints: unexpectedCapabilityUse,
      deleteCheckpointRefs: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(TextGeneration.TextGeneration)({
      generateCommitMessage: unexpectedCapabilityUse,
      generatePrContent: unexpectedCapabilityUse,
      generateBranchName: unexpectedCapabilityUse,
      generateThreadTitle: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      get: unexpectedCapabilityUse,
      resolveHandle: unexpectedCapabilityUse,
      resolve: unexpectedCapabilityUse,
      discover: unexpectedCapabilityUse(),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(GitHubCli.GitHubCli)({
      execute: unexpectedCapabilityUse,
      listOpenPullRequests: unexpectedCapabilityUse,
      getPullRequest: unexpectedCapabilityUse,
      getRepositoryCloneUrls: unexpectedCapabilityUse,
      createRepository: unexpectedCapabilityUse,
      createPullRequest: unexpectedCapabilityUse,
      getDefaultBranch: unexpectedCapabilityUse,
      checkoutPullRequest: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mock(TerminalManager.TerminalManager)({
      open: unexpectedCapabilityUse,
      attachStream: unexpectedCapabilityUse,
      write: unexpectedCapabilityUse,
      resize: unexpectedCapabilityUse,
      clear: unexpectedCapabilityUse,
      restart: unexpectedCapabilityUse,
      close: unexpectedCapabilityUse,
      subscribe: unexpectedCapabilityUse,
      subscribeMetadata: unexpectedCapabilityUse,
    }),
  ),
);

const testLayer = testLayerBase.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-host-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(testLayer);

const now = "2026-07-03T00:00:00.000Z";
const decodeCapabilityMarker = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      httpBasePath: Schema.String,
      terminalsUnavailable: Schema.Boolean,
    }),
  ),
);

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
  readonly capabilities?: ReadonlyArray<PluginCapability>;
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
      capabilities: input.capabilities ?? [],
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

const capabilityGateEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const Effect = require("effect/Effect");
const NodeFs = require("node:fs");

export default {
  register(hostApi) {
    return Effect.gen(function* () {
      const http = yield* hostApi.http;
      let terminalsUnavailable = false;
      const terminalsExit = yield* Effect.exit(hostApi.terminals);
      terminalsUnavailable = terminalsExit._tag === "Failure";
      NodeFs.mkdirSync(hostApi.config.dataDir, { recursive: true });
      NodeFs.writeFileSync(
        hostApi.config.dataDir + "/capabilities.json",
        JSON.stringify({ httpBasePath: http.basePath, terminalsUnavailable }),
      );
      return {
        http: [
          {
            method: "POST",
            path: "/ping/:name",
            auth: "public",
            handler: (request) =>
              Effect.succeed({
                status: 200,
                body: { name: request.params.name },
              }),
          },
        ],
      };
    });
  },
};
`;

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

  it.effect("publishes plugin state changes on the server lifecycle stream", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("lifecycle-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

      const eventFiber = yield* lifecycleEvents.stream.pipe(
        Stream.filter((event) => event.type === "plugins" && event.payload.pluginId === pluginId),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* installPlugin({ pluginId, entrySource: "throw new Error('lifecycle boom');" });
      yield* host.start;

      const events = Array.from(yield* Fiber.join(eventFiber));
      assert.deepEqual(events[0]?.payload, {
        kind: "plugin-state-changed",
        pluginId,
        state: "failed",
      });
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

  it.effect("passes only declared capabilities and registers http routes on activation", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("capability-plugin");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* PluginHostModule.PluginHost;
      const httpRegistry = yield* PluginHttpRegistry.PluginHttpRegistry;

      yield* installPlugin({
        pluginId,
        capabilities: ["http"],
        entrySource: capabilityGateEntrySource(),
      });

      yield* host.start;
      yield* Effect.yieldNow;

      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const capabilityFile = yield* fs.readFileString(path.join(dataDir, "capabilities.json"));
      assert.deepEqual(yield* decodeCapabilityMarker(capabilityFile), {
        httpBasePath: "/hooks/plugins/capability-plugin",
        terminalsUnavailable: true,
      });

      const match = yield* httpRegistry.match({
        pluginId,
        method: "POST",
        path: "/ping/chris",
      });
      assert.isTrue(Option.isSome(match));
      if (Option.isSome(match)) {
        assert.deepEqual(match.value.params, { name: "chris" });
      }
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
