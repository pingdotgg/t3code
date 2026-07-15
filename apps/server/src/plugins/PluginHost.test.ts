import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import {
  PluginId,
  PluginManifest,
  type PluginCapability,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import { fingerprintSettingsSchema } from "@t3tools/shared/pluginSettings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
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
import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import * as PluginHostModule from "./PluginHost.ts";
import * as PluginHttpRegistry from "./PluginHttpRegistry.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import * as PluginMigrator from "./PluginMigrator.ts";
import * as PluginModuleLoaderLayer from "./PluginModuleLoader.ts";
import { pluginDataDir, pluginVersionDir } from "./PluginPaths.ts";
import * as PluginRuntimeRegistryLayer from "./PluginRuntimeRegistry.ts";
import { CONTEXT_MAX_BYTES_PER_PLUGIN } from "./PluginContextComposer.ts";
import * as PluginContextComposerLayer from "./PluginContextComposer.ts";
import * as PluginSettingsStoreLayer from "./PluginSettingsStore.ts";
import * as PluginToolCatalogLayer from "./PluginToolCatalog.ts";

const encodeManifestJson = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));
const unexpectedCapabilityUse = () =>
  Effect.die(new Error("unexpected capability use in host test"));

const PluginRuntimeRegistryLayerLive = PluginRuntimeRegistryLayer.layer;
const PluginToolCatalogLayerLive = PluginToolCatalogLayer.layer.pipe(
  Layer.provide(PluginRuntimeRegistryLayerLive),
);

const testLayerBase = PluginHostModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayer.layer),
  Layer.provideMerge(PluginModuleLoaderLayer.layer),
  Layer.provideMerge(PluginMigrator.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      PluginRuntimeRegistryLayerLive,
      PluginToolCatalogLayerLive,
      PluginSettingsStoreLayer.layer,
      PluginContextComposerLayer.layer,
      PluginHttpRegistry.layer,
    ),
  ),
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
      mergePullRequest: unexpectedCapabilityUse,
      getPullRequestDetail: unexpectedCapabilityUse,
      listPullRequestChecks: unexpectedCapabilityUse,
      listPullRequestReviews: unexpectedCapabilityUse,
      listPullRequestReviewComments: unexpectedCapabilityUse,
      getDefaultBranch: unexpectedCapabilityUse,
      checkoutPullRequest: unexpectedCapabilityUse,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
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
      Layer.succeed(OutboundUrlLookup, () =>
        Effect.die(new Error("unexpected outbound lookup in host test")),
      ),
      Layer.succeed(PluginHttpClientTransportService, () =>
        Effect.die(new Error("unexpected http client transport in host test")),
      ),
    ),
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
const decodeNewCapabilityMarker = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      filesystemAvailable: Schema.Boolean,
      filesystemUnavailable: Schema.Boolean,
      httpClientAvailable: Schema.Boolean,
      httpClientUnavailable: Schema.Boolean,
      eventsAvailable: Schema.Boolean,
      eventsUnavailable: Schema.Boolean,
    }),
  ),
);
const decodeCaughtMarker = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ caught: Schema.String })),
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
  /** Declare a `web` manifest entry. Required for declarative settings, whose page
   *  the host renders into the plugin's web surface. */
  readonly webEntry?: boolean;
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
      entries:
        input.webEntry === true ? { server: "server.js", web: "web.js" } : { server: "server.js" },
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

const newCapabilityGateEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const Effect = require("effect/Effect");
const NodeFs = require("node:fs");

const available = (effect) => Effect.exit(effect).pipe(Effect.map((exit) => exit._tag === "Success"));
const unavailable = (effect) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => exit._tag === "Failure" && String(exit.cause).includes("PluginCapabilityUnavailable")),
  );

export default {
  register(hostApi) {
    return Effect.gen(function* () {
      const marker = {
        filesystemAvailable: yield* available(hostApi.filesystem),
        filesystemUnavailable: yield* unavailable(hostApi.filesystem),
        httpClientAvailable: yield* available(hostApi.httpClient),
        httpClientUnavailable: yield* unavailable(hostApi.httpClient),
        eventsAvailable: yield* available(hostApi.events),
        eventsUnavailable: yield* unavailable(hostApi.events),
      };
      NodeFs.mkdirSync(hostApi.config.dataDir, { recursive: true });
      NodeFs.writeFileSync(hostApi.config.dataDir + "/new-capabilities.json", JSON.stringify(marker));
      return {};
    });
  },
};
`;

const interruptEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const Effect = require("effect/Effect");

export default {
  register() {
    // Genuinely interrupt activation for THIS plugin. In start's per-plugin loop
    // an interrupt-only cause now RE-RAISES (host-shutdown semantics), stopping
    // the loop promptly rather than plodding through the remaining plugins.
    return Effect.interrupt;
  },
};
`;

const cancelDuringActivationEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const NodeFs = require("node:fs");
const NodePath = require("node:path");

export default {
  register(hostApi) {
    // Simulate a concurrent disable/uninstall landing DURING activation: flip
    // this plugin's persisted lifecycle state to "disabled" BEFORE the host's
    // pre-put re-check reads it, so the host aborts activation via the typed
    // PluginActivationCanceled sentinel (not a fiber interrupt). dataDir is
    // <pluginsDir>/<id>/data, so the lockfile is two levels up.
    const dataDir = hostApi.config.dataDir;
    const pluginRoot = NodePath.dirname(dataDir);
    const pluginId = NodePath.basename(pluginRoot);
    const lockfilePath = NodePath.join(NodePath.dirname(pluginRoot), "plugins.json");
    const lockfile = JSON.parse(NodeFs.readFileSync(lockfilePath, "utf8"));
    lockfile.plugins[pluginId].state = "disabled";
    NodeFs.writeFileSync(lockfilePath, JSON.stringify(lockfile));
    return {};
  },
};
`;

const registerCountEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const NodeFs = require("node:fs");

export default {
  register(hostApi) {
    // Append one marker per register() call so the test can assert loadPlugin ran
    // exactly once under concurrent activation.
    NodeFs.mkdirSync(hostApi.config.dataDir, { recursive: true });
    NodeFs.appendFileSync(hostApi.config.dataDir + "/register-count", "x");
    return {};
  },
};
`;

const catchUnavailableEntrySource = () => `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(NodeURL.pathToFileURL(import.meta.url).href)});
const Effect = require("effect/Effect");
const NodeFs = require("node:fs");

export default {
  register(hostApi) {
    return Effect.gen(function* () {
      // hostApi.agents is undeclared for this plugin. A typed Effect.fail is
      // recoverable via Effect.catch; a defect (Effect.die) would NOT be caught
      // and would crash register instead of degrading gracefully.
      const caught = yield* hostApi.agents.pipe(
        Effect.as("unexpected-success"),
        Effect.catch((error) => Effect.succeed(error && error._tag ? error._tag : "unknown")),
      );
      NodeFs.mkdirSync(hostApi.config.dataDir, { recursive: true });
      NodeFs.writeFileSync(hostApi.config.dataDir + "/caught.json", JSON.stringify({ caught }));
      return {};
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

  it.effect(
    "setPluginEnabled runs persist + host action atomically, so concurrent disable/enable cannot strand the plugin",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("test-plugin");
        const host = yield* PluginHostModule.PluginHost;
        const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
        const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

        yield* runMigrations({ toMigrationInclusive: 34 });
        yield* installPlugin({ pluginId });
        const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
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
        assert.isTrue(
          Option.isSome(yield* registry.get(pluginId)),
          "precondition: runtime is live",
        );

        const persistState = (enabled: boolean) =>
          store
            .updatePlugin(pluginId, ({ current }) =>
              Effect.succeed({
                ...makeLockEntry(current ?? {}),
                enabled,
                state: enabled ? ("active" as const) : ("disabled" as const),
              }),
            )
            .pipe(Effect.orDie, Effect.asVoid);

        // Hold DISABLE inside its persist, while it owns the activation lock.
        // `enteredPersist` makes this deterministic: we do not fork enable until
        // disable has provably reached its persist, i.e. is holding the lock.
        // (An earlier version used yieldNow to guess and was flaky — if enable won
        // the lock first the assertion below fired spuriously.)
        const enteredPersist = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let enablePersisted = false;

        const disableFiber = yield* host
          .setPluginEnabled(
            pluginId,
            false,
            Deferred.succeed(enteredPersist, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(persistState(false)),
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));

        // Deterministic: disable now holds the activation lock and is parked.
        yield* Deferred.await(enteredPersist);

        const enableFiber = yield* host
          .setPluginEnabled(
            pluginId,
            true,
            Effect.sync(() => {
              enablePersisted = true;
            }).pipe(Effect.andThen(persistState(true))),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // THE ASSERTION THAT MATTERS. Disable owns the lock and is parked mid-persist,
        // so enable must still be queued behind it. If persist is ever hoisted back
        // outside withPluginActivationLock, enable's write lands here and this fails —
        // which is exactly the interleaving that stranded the plugin as
        // lockfile-enabled with no runtime.
        assert.isFalse(
          enablePersisted,
          "enable persisted while disable held the activation lock — persist is not atomic with the host action",
        );

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(disableFiber);
        yield* Fiber.join(enableFiber);

        // Guards the assertion above against passing vacuously: if enable had never
        // been scheduled at all, `enablePersisted === false` would prove nothing.
        assert.isTrue(enablePersisted, "enable must persist once the lock is released");

        // Whoever acquired the lock last wins, but the result must be coherent:
        // lockfile enabled+active if and only if a runtime is present.
        const lockfile = yield* store.readLockfile;
        const entry = lockfile.plugins[pluginId];
        const lockfileActive = entry?.enabled === true && entry.state === "active";
        const runtimePresent = Option.isSome(yield* registry.get(pluginId));
        assert.equal(
          runtimePresent,
          lockfileActive,
          `incoherent final state: lockfileActive=${lockfileActive} runtimePresent=${runtimePresent}`,
        );
      }),
  );

  it.effect(
    "clears activatingSince immediately on success, before the healthy window elapses",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("test-plugin");
        const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
        const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
        const host = yield* PluginHostModule.PluginHost;
        const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

        yield* runMigrations({ toMigrationInclusive: 34 });
        // Seed a prior crashCount so we can prove it is NOT reset yet (the delayed
        // reset is gated behind a long stability window that never elapses here).
        yield* installPlugin({
          pluginId,
          lockEntry: { activation: { activatingSince: null, crashCount: 1 } },
        });

        // A long window means the delayed crashCount reset never fires during the
        // test; only the immediate on-success clear of activatingSince can run.
        process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "600000";
        try {
          yield* host.start;
          for (let attempt = 0; attempt < 10; attempt++) {
            if ((yield* registry.list).length === 1) break;
            yield* Effect.yieldNow;
          }
        } finally {
          if (previousHealthyDelay === undefined) {
            delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
          } else {
            process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
          }
        }

        assert.equal((yield* registry.list).length, 1);
        const lockfile = yield* store.readLockfile;
        // activatingSince cleared on successful activation (a quick restart now
        // would NOT be mistaken for an interrupted activation)...
        assert.equal(lockfile.plugins[pluginId]?.activation.activatingSince, null);
        // ...while crashCount is still preserved until the stability window ends.
        assert.equal(lockfile.plugins[pluginId]?.activation.crashCount, 1);
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

  it.effect("gates filesystem and httpClient independently by manifest declaration", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* PluginHostModule.PluginHost;

      const cases = [
        {
          pluginId: PluginId.make("filesystem-only"),
          capabilities: ["filesystem"] as const,
          expected: {
            filesystemAvailable: true,
            filesystemUnavailable: false,
            httpClientAvailable: false,
            httpClientUnavailable: true,
            eventsAvailable: false,
            eventsUnavailable: true,
          },
        },
        {
          pluginId: PluginId.make("http-client-only"),
          capabilities: ["httpClient"] as const,
          expected: {
            filesystemAvailable: false,
            filesystemUnavailable: true,
            httpClientAvailable: true,
            httpClientUnavailable: false,
            eventsAvailable: false,
            eventsUnavailable: true,
          },
        },
        {
          pluginId: PluginId.make("neither-new-cap"),
          capabilities: [] as const,
          expected: {
            filesystemAvailable: false,
            filesystemUnavailable: true,
            httpClientAvailable: false,
            httpClientUnavailable: true,
            eventsAvailable: false,
            eventsUnavailable: true,
          },
        },
        {
          // The event stream carries activity from EVERY project, so reaching it
          // without the user having granted `events` is a privacy failure, not just
          // a missing feature.
          pluginId: PluginId.make("events-only"),
          capabilities: ["events"] as const,
          expected: {
            filesystemAvailable: false,
            filesystemUnavailable: true,
            httpClientAvailable: false,
            httpClientUnavailable: true,
            eventsAvailable: true,
            eventsUnavailable: false,
          },
        },
      ];

      for (const testCase of cases) {
        yield* installPlugin({
          pluginId: testCase.pluginId,
          capabilities: testCase.capabilities,
          entrySource: newCapabilityGateEntrySource(),
        });
      }

      yield* host.start;
      yield* Effect.yieldNow;

      for (const testCase of cases) {
        const dataDir = pluginDataDir(config.pluginsDir, testCase.pluginId, path.join);
        const marker = yield* fs.readFileString(path.join(dataDir, "new-capabilities.json"));
        assert.deepEqual(yield* decodeNewCapabilityMarker(marker), testCase.expected);
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
      // Migrations must run: removing plugin data now DELETES the plugin's settings
      // row and fails loudly if it cannot (a swallowed failure would report the data
      // gone while it survived). Without the table, reconcile correctly refuses to
      // drop the lockfile entry — which is the retry behaviour, not a bug.
      yield* runMigrations({});
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

  it.effect("resets crash health when promoting a staged upgrade", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("upgrade-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
      const emptyEntry = "export default { register() { return {}; } };";

      yield* runMigrations({ toMigrationInclusive: 34 });
      // Both the current (1.0.0) and staged (2.0.0) version dirs must exist so
      // the post-promotion load of 2.0.0 succeeds.
      yield* installPlugin({ pluginId, entrySource: emptyEntry, lockEntry: { version: "1.0.0" } });
      yield* installPlugin({ pluginId, entrySource: emptyEntry, lockEntry: { version: "2.0.0" } });
      // Stage a pending upgrade carrying a prior crashCount + error that must NOT
      // carry over to the new build.
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed(
          makeLockEntry({
            version: "1.0.0",
            state: "pending-upgrade",
            staged: { version: "2.0.0", sha256: "sha2", stagedAt: now },
            activation: { activatingSince: null, crashCount: 1 },
            lastError: "old failure",
          }),
        ),
      );

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        yield* host.start;
        for (let attempt = 0; attempt < 10; attempt++) {
          if ((yield* registry.list).some((runtime) => runtime.manifest.id === pluginId)) break;
          yield* Effect.yieldNow;
        }
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      const lockfile = yield* store.readLockfile;
      const entry = lockfile.plugins[pluginId];
      assert.equal(entry?.version, "2.0.0");
      assert.equal(entry?.state, "active");
      assert.equal(entry?.activation.crashCount, 0);
      assert.equal(entry?.lastError, null);
    }),
  );

  it.effect("deactivatePlugin publishes the persisted state, not a hardcoded disabled", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("deactivate-state-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

      // Subscribe before start (like the lifecycle test above) to deterministically
      // observe both the activation "active" publish and the later deactivation
      // publish.
      const eventFiber = yield* lifecycleEvents.stream.pipe(
        Stream.filter((event) => event.type === "plugins" && event.payload.pluginId === pluginId),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      // A migration-free entry so activation succeeds regardless of sibling tests
      // (still enters the runtime registry, so deactivate finds a live runtime).
      yield* installPlugin({
        pluginId,
        entrySource: "export default { register() { return {}; } };",
      });

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        yield* host.start;
        for (let attempt = 0; attempt < 10; attempt++) {
          if ((yield* registry.list).some((runtime) => runtime.manifest.id === pluginId)) break;
          yield* Effect.yieldNow;
        }
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      // Persist "pending-remove" (as uninstall does) before tearing down.
      yield* store.updatePlugin(pluginId, ({ current }) =>
        Effect.succeed(
          current ? { ...current, state: "pending-remove", enabled: false } : undefined,
        ),
      );
      yield* host.deactivatePlugin(pluginId);

      const events = Array.from(yield* Fiber.join(eventFiber));
      assert.deepEqual(events[0]?.payload, {
        kind: "plugin-state-changed",
        pluginId,
        state: "active",
      });
      // The deactivation publish reflects the ACTUAL persisted state
      // ("pending-remove"), not a hardcoded "disabled".
      assert.deepEqual(events[1]?.payload, {
        kind: "plugin-state-changed",
        pluginId,
        state: "pending-remove",
      });
    }),
  );

  it.effect("an undeclared capability fails with a catchable typed error, not a defect", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("catch-capability");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;

      yield* installPlugin({
        pluginId,
        capabilities: [],
        entrySource: catchUnavailableEntrySource(),
      });

      yield* host.start;
      yield* Effect.yieldNow;

      // register completed (a defect would have crashed it) and the plugin is
      // active, having recovered from the undeclared-capability failure.
      const runtimes = yield* registry.list;
      assert.isTrue(runtimes.some((runtime) => runtime.manifest.id === pluginId));

      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const caughtFile = yield* fs.readFileString(path.join(dataDir, "caught.json"));
      assert.deepEqual(yield* decodeCaughtMarker(caughtFile), {
        caught: "PluginCapabilityUnavailable",
      });
    }),
  );

  it.effect(
    "a cancelled activation clears activatingSince and is not counted as a crash (R5-1)",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("cancel-clears-marker-plugin");
        const host = yield* PluginHostModule.PluginHost;
        const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
        const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
        const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

        // The plugin flips its own lockfile state to "disabled" mid-register, so
        // the host's pre-put re-check aborts activation via the typed cancel
        // sentinel (a concurrent disable/uninstall arriving during activation).
        yield* installPlugin({
          pluginId,
          entrySource: cancelDuringActivationEntrySource(),
        });

        process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
        try {
          yield* host.start;
        } finally {
          if (previousHealthyDelay === undefined) {
            delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
          } else {
            process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
          }
        }

        // The plugin did not go live.
        const runtimes = yield* registry.list;
        assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === pluginId));

        const entry = (yield* store.readLockfile).plugins[pluginId];
        // Core R5-1 regression: the activating marker is cleared on the clean
        // cancel teardown (the OLD interrupt branch skipped this, leaving it
        // set)...
        assert.equal(entry?.activation.activatingSince, null);
        // ...the intentional cancellation is NOT counted as a crash...
        assert.equal(entry?.activation.crashCount, 0);
        // ...and it is NOT marked "failed"; the requested state is preserved.
        assert.notEqual(entry?.state, "failed");
        assert.equal(entry?.state, "disabled");
      }),
  );

  it.effect("start skips a plugin whose activation is cancelled and still activates the rest", () =>
    Effect.gen(function* () {
      const cancelledId = PluginId.make("cancel-during-start-plugin");
      const survivorId = PluginId.make("after-cancel-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

      // Insertion order: the cancelling plugin is processed first, so if its
      // cancel aborted the loop the survivor would never activate. The typed
      // sentinel keeps the loop going (unlike a genuine interrupt).
      yield* installPlugin({
        pluginId: cancelledId,
        entrySource: cancelDuringActivationEntrySource(),
      });
      yield* installPlugin({
        pluginId: survivorId,
        entrySource: "export default { register() { return {}; } };",
      });

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        yield* host.start;
        for (let attempt = 0; attempt < 10; attempt++) {
          if ((yield* registry.list).some((runtime) => runtime.manifest.id === survivorId)) break;
          yield* Effect.yieldNow;
        }
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      const runtimes = yield* registry.list;
      // The cancelled plugin did not activate...
      assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === cancelledId));
      // ...but the loop continued and activated the next plugin.
      assert.isTrue(runtimes.some((runtime) => runtime.manifest.id === survivorId));
      // The cancel left the marker cleared and the requested state intact.
      const entry = (yield* store.readLockfile).plugins[cancelledId];
      assert.equal(entry?.activation.activatingSince, null);
      assert.equal(entry?.state, "disabled");
    }),
  );

  it.effect("start stops the loop when a plugin's activation is genuinely interrupted (R5-2)", () =>
    Effect.gen(function* () {
      const interruptedId = PluginId.make("shutdown-interrupt-plugin");
      const survivorId = PluginId.make("after-shutdown-interrupt-plugin");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

      // Insertion order: the interrupting plugin is processed first. A GENUINE
      // interrupt-only cause (host-shutdown semantics) now re-raises out of the
      // loop, so the survivor that follows must NOT be reached.
      yield* installPlugin({ pluginId: interruptedId, entrySource: interruptEntrySource() });
      yield* installPlugin({
        pluginId: survivorId,
        entrySource: "export default { register() { return {}; } };",
      });

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        // host.start completes (the trailing ignoreCause swallows the re-raised
        // interrupt) but the loop terminated early at the interrupted plugin.
        yield* host.start;
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      const runtimes = yield* registry.list;
      // The interrupted plugin did not activate...
      assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === interruptedId));
      // ...and the loop STOPPED, so the following plugin was never reached.
      assert.isFalse(runtimes.some((runtime) => runtime.manifest.id === survivorId));
      const entry = (yield* store.readLockfile).plugins[interruptedId];
      // The interrupt teardown clears the activating marker (so a later start
      // does not miscount it as a crash) and leaves the persisted state intact.
      assert.equal(entry?.activation.activatingSince, null);
      assert.equal(entry?.state, "active");

      // Neutralize the genuinely-interrupting plugin so it cannot stop the loop
      // of any host.start run by a later test in this shared-lockfile block.
      yield* store.updatePlugin(interruptedId, ({ current }) =>
        Effect.succeed(current ? { ...current, enabled: false, state: "disabled" } : undefined),
      );
    }),
  );

  it.effect(
    "activatePlugin fails instead of silently no-opping when the lockfile is unreadable",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("read-failure-plugin");
        const fs = yield* FileSystem.FileSystem;
        const host = yield* PluginHostModule.PluginHost;
        const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

        // Install so a valid lockfile exists, then corrupt it so readLockfile fails
        // with a parse error (NOT NotFound, which readLockfile treats as an empty
        // lockfile). Restore it afterwards so the shared lockfile stays valid for
        // sibling tests.
        yield* installPlugin({ pluginId });
        const original = yield* fs.readFileString(store.lockfilePath);
        yield* fs.writeFileString(store.lockfilePath, "{ not valid json");

        const exit = yield* Effect.exit(host.activatePlugin(pluginId));

        yield* fs.writeFileString(store.lockfilePath, original);
        // Previously the read failure was swallowed and replaced with an empty
        // lockfile, so activatePlugin SUCCEEDED without loading anything. It must now
        // propagate the failure.
        assert.isTrue(Exit.isFailure(exit));
      }),
  );

  it.effect(
    "concurrent activatePlugin for the same plugin loads it once (single-flight, no leaked runtime)",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("single-flight-plugin");
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* PluginHostModule.PluginHost;
        const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
        const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

        yield* installPlugin({ pluginId, entrySource: registerCountEntrySource() });

        process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
        try {
          // Two concurrent activations. Without single-flight both pass the empty-
          // registry check and both run loadPlugin (→ two register() calls; the
          // first runtime's scope is leaked when the second registry.put overwrites
          // it). The per-plugin lock serializes them so the second's registry.get
          // double-check short-circuits.
          yield* Effect.all([host.activatePlugin(pluginId), host.activatePlugin(pluginId)], {
            concurrency: "unbounded",
          });
        } finally {
          if (previousHealthyDelay === undefined) {
            delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
          } else {
            process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
          }
        }

        // register() ran exactly once → loadPlugin ran exactly once.
        const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
        const registerCount = yield* fs.readFileString(path.join(dataDir, "register-count"));
        assert.equal(registerCount, "x");
        // Exactly one live runtime is registered for the plugin.
        const runtimes = yield* registry.list;
        assert.equal(runtimes.filter((runtime) => runtime.manifest.id === pluginId).length, 1);
      }),
  );

  it.effect("concurrent host.start and activatePlugin for the same plugin load it once", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("start-vs-activate-plugin");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const previousHealthyDelay = process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;

      yield* installPlugin({ pluginId, entrySource: registerCountEntrySource() });

      process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      try {
        // The start loop and an enable/install RPC's activatePlugin race for the
        // SAME plugin. Before the fix the start loop called loadPlugin directly,
        // bypassing the per-plugin single-flight lock, so both could run
        // loadPlugin: register() twice, migrator twice (the second
        // plugin_migrations INSERT PK-conflicts → spurious "failed"), and the
        // second registry.put orphaned the first runtime's scope. Routing the
        // start loop through the shared lock + a registry.get double-check makes
        // it load exactly once regardless of who wins the race.
        yield* Effect.all([host.start, host.activatePlugin(pluginId)], {
          concurrency: "unbounded",
        });
      } finally {
        if (previousHealthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previousHealthyDelay;
        }
      }

      // register() ran exactly once → loadPlugin ran exactly once.
      const dataDir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const registerCount = yield* fs.readFileString(path.join(dataDir, "register-count"));
      assert.equal(registerCount, "x");
      const runtimes = yield* registry.list;
      assert.equal(runtimes.filter((runtime) => runtime.manifest.id === pluginId).length, 1);
    }),
  );

  // NOTE: the EXTERNAL-interrupt teardown fix in loadPlugin (the uninterruptibleMask
  // ladder that lets Scope.close + registry.remove + clearActivatingMarker run when
  // effect@4.0.0-beta.78's `Effect.exit` cannot capture an external fiber interrupt)
  // is exercised by standalone runtime probes rather than an integration test here:
  // externally interrupting a REAL forked/raced activation makes the plugin's
  // dynamic import never settle under vite-plus/vitest, hanging the run before the
  // interrupt path is even reached. The internal-interrupt path is covered by the
  // "start stops the loop when a plugin's activation is genuinely interrupted"
  // (R5-2) test above.
});

describe("PluginHost cause predicates", () => {
  const sentinel = (reason: string) =>
    new PluginHostModule.PluginActivationCanceled({ pluginId: "p", reason });

  it("causeIsActivationCanceledOnly is true ONLY when every reason is the cancel sentinel", () => {
    // A single sentinel fail, and several sentinel fails, are pure cancels.
    assert.isTrue(PluginHostModule.causeIsActivationCanceledOnly(Cause.fail(sentinel("disabled"))));
    assert.isTrue(
      PluginHostModule.causeIsActivationCanceledOnly(
        Cause.combine(Cause.fail(sentinel("a")), Cause.fail(sentinel("b"))),
      ),
    );

    // A MIXED cause (sentinel + teardown defect, or sentinel + interrupt) must
    // NOT count as a clean cancel — otherwise a real teardown failure would be
    // silently dropped and a shutdown interrupt swallowed.
    assert.isFalse(
      PluginHostModule.causeIsActivationCanceledOnly(
        Cause.combine(Cause.fail(sentinel("x")), Cause.die(new Error("teardown"))),
      ),
    );
    assert.isFalse(
      PluginHostModule.causeIsActivationCanceledOnly(
        Cause.combine(Cause.fail(sentinel("x")), Cause.interrupt()),
      ),
    );

    // A pure interrupt and a pure non-sentinel error are not cancels; neither is
    // the empty cause (no reasons).
    assert.isFalse(PluginHostModule.causeIsActivationCanceledOnly(Cause.interrupt()));
    assert.isFalse(PluginHostModule.causeIsActivationCanceledOnly(Cause.fail(new Error("boom"))));
    assert.isFalse(PluginHostModule.causeIsActivationCanceledOnly(Cause.empty));
  });

  it("causeContainsInterrupt is true whenever the cause carries ANY interrupt reason", () => {
    // A pure interrupt and a sentinel+interrupt mix both contain an interrupt.
    assert.isTrue(PluginHostModule.causeContainsInterrupt(Cause.interrupt()));
    assert.isTrue(
      PluginHostModule.causeContainsInterrupt(
        Cause.combine(Cause.fail(sentinel("x")), Cause.interrupt()),
      ),
    );

    // A pure sentinel, a pure error, and sentinel+defect carry no interrupt.
    assert.isFalse(PluginHostModule.causeContainsInterrupt(Cause.fail(sentinel("x"))));
    assert.isFalse(PluginHostModule.causeContainsInterrupt(Cause.fail(new Error("boom"))));
    assert.isFalse(
      PluginHostModule.causeContainsInterrupt(
        Cause.combine(Cause.fail(sentinel("x")), Cause.die(new Error("teardown"))),
      ),
    );
  });
});

// A SEPARATE layer block, deliberately.
//
// `it.layer(testLayer)` builds a fresh registry/lockfile/sqlite per describe block,
// but tests WITHIN a block share them. These tests install plugins, and the
// "PluginHost" block asserts `registry.list.length === 1` — an extra lockfile entry
// there makes host.start activate a second plugin and breaks that assertion. (First
// attempt lived in that block: the tests were vacuous because registry.get observed
// a runtime from an earlier test, and once given distinct ids they broke the
// neighbour instead.) Isolating them is what makes both sides honest.
layer("PluginHost settings validation", (it) => {
  // Settings schema the host form cannot render: Number has no numeric control, so
  // it would be drawn as a text box and every write it produced would fail.
  const unrenderableEntry = `
import * as Schema from "effect/Schema";
export default {
  settings: { schema: Schema.Struct({ retries: Schema.Number }) },
  register() { return {}; },
};
`;
  const renderableEntry = `
import * as Schema from "effect/Schema";
export default {
  settings: { schema: Schema.Struct({ baseUrl: Schema.String }) },
  register() { return {}; },
};
`;

  it.effect("refuses to activate a plugin whose settings schema is not renderable", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-unrenderable");
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const host = yield* PluginHostModule.PluginHost;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["settings"],
        entrySource: unrenderableEntry,
        webEntry: true,
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(
        Option.isNone(yield* registry.get(pluginId)),
        "a plugin whose settings schema cannot be rendered must not activate",
      );
      const lockfile = yield* store.readLockfile;
      assert.match(
        lockfile.plugins[pluginId]?.lastError ?? "",
        /retries/,
        "the failure must name the offending field, not just say 'invalid'",
      );
    }),
  );

  // The capability is what the user consents to; settings without it would read
  // config the user never granted access to.
  it.effect("refuses to activate a plugin declaring settings without the settings capability", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-nocapability");
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const host = yield* PluginHostModule.PluginHost;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: [],
        entrySource: renderableEntry,
        webEntry: true,
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(Option.isNone(yield* registry.get(pluginId)));
      const lockfile = yield* store.readLockfile;
      assert.match(lockfile.plugins[pluginId]?.lastError ?? "", /capability/);
    }),
  );

  // The settings page is HOST-rendered into the plugin's web surface, so a plugin
  // with no web entry has nowhere to render one — its settings could never be filled
  // in by anyone.
  it.effect("refuses to activate a server-only plugin that declares settings", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-serveronly");
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;
      const host = yield* PluginHostModule.PluginHost;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["settings"],
        entrySource: renderableEntry,
        webEntry: false,
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(Option.isNone(yield* registry.get(pluginId)));
      const lockfile = yield* store.readLockfile;
      assert.match(lockfile.plugins[pluginId]?.lastError ?? "", /web/);
    }),
  );

  // Caching the declaration BEFORE validating it meant a plugin the host had just
  // rejected — no `settings` capability, or no web surface to render the form on —
  // still populated the declaration map and could serve settings RPCs for a schema
  // that is not allowed to exist.
  it.effect("does not record a declaration for a plugin whose settings are rejected", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-rejected-declaration");
      const host = yield* PluginHostModule.PluginHost;
      const settingsStore = yield* PluginSettingsStoreLayer.PluginSettingsStore;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        // Declares settings but never requested the capability: validation rejects it.
        capabilities: [],
        entrySource: renderableEntry,
        webEntry: true,
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(
        Option.isNone(yield* settingsStore.declaredSchema(pluginId)),
        "a rejected settings descriptor must not be cached as a declaration",
      );
    }),
  );

  it.effect("activates a plugin whose settings schema is renderable", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-renderable");
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const host = yield* PluginHostModule.PluginHost;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["settings"],
        entrySource: renderableEntry,
        webEntry: true,
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(
        Option.isSome(yield* registry.get(pluginId)),
        "a renderable settings schema must not block activation",
      );
    }),
  );
});

// The settings CAPABILITY, exercised by a real plugin through a real hostApi.
//
// The validation block above only proves activation is gated. It never obtains
// `hostApi.settings`, so the read guards and the changes stream were entirely
// untested — deleting the corrupt-storage guard or collapsing per-event recovery
// into a per-stream catch left every test green. These drive the capability the
// only way a plugin can reach it: register(hostApi), plus a plugin `service` for
// the subscription, which is the host-forked home for long-running plugin work.
layer("PluginHost context contribution", (it) => {
  const contextEntry = (text: string) => `
export default {
  register() {
    return { context: [{ name: "conventions", text: ${JSON.stringify(text)} }] };
  },
};
`;

  it.effect("registers a contribution for a plugin holding the context capability", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("context-ok");
      const host = yield* PluginHostModule.PluginHost;
      const composer = yield* PluginContextComposerLayer.PluginContextComposer;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["context"],
        entrySource: contextEntry("Use tabs."),
      });
      yield* host.activatePlugin(pluginId);

      const composed = yield* composer.compose({
        threadId: ThreadId.make("t"),
        projectId: null,
        interactionMode: "default",
      });
      assert.strictEqual(composed.text, "Use tabs.");
    }),
  );

  // Contributing context is influence over what the agent DOES. Reaching it without
  // the user having granted it is not a missing feature, it is an unconsented grant.
  it.effect("refuses to activate a plugin contributing context without the capability", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("context-nocapability");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: [],
        entrySource: contextEntry("Use tabs."),
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(Option.isNone(yield* registry.get(pluginId)));
      const lockfile = yield* store.readLockfile;
      assert.match(lockfile.plugins[pluginId]?.lastError ?? "", /context/);
    }),
  );

  // Rejected at ACTIVATION rather than dropped on every turn: an author who never
  // sees the failure cannot fix it.
  it.effect("refuses to activate a plugin whose static contribution is over the cap", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("context-oversized");
      const host = yield* PluginHostModule.PluginHost;
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const store = yield* PluginLockfileStoreLayer.PluginLockfileStore;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["context"],
        entrySource: contextEntry("x".repeat(CONTEXT_MAX_BYTES_PER_PLUGIN + 1)),
      });
      yield* host.activatePlugin(pluginId);

      assert.isTrue(Option.isNone(yield* registry.get(pluginId)));
      const lockfile = yield* store.readLockfile;
      assert.match(lockfile.plugins[pluginId]?.lastError ?? "", /limit/);
    }),
  );

  it.effect("stops contributing once the plugin is deactivated", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("context-teardown");
      const host = yield* PluginHostModule.PluginHost;
      const composer = yield* PluginContextComposerLayer.PluginContextComposer;

      yield* runMigrations({});
      // Text unique to THIS plugin: `it.layer` shares one composer across the block,
      // so asserting on the composed text as a whole would be asserting about the
      // neighbouring tests' plugins too — which is how this test first "failed".
      yield* installPlugin({
        pluginId,
        capabilities: ["context"],
        entrySource: contextEntry("Torn down."),
      });
      yield* host.activatePlugin(pluginId);
      const before = yield* composer.compose({
        threadId: ThreadId.make("t"),
        projectId: null,
        interactionMode: "default",
      });
      assert.isTrue(before.text.includes("Torn down."), "precondition: it contributes");

      // `persist` is the lockfile write to run under the activation lock; nothing to
      // persist here, only the deactivation.
      yield* host.setPluginEnabled(pluginId, false, Effect.void);

      // A disabled plugin that keeps steering the agent is a disabled plugin that is
      // still running.
      const composed = yield* composer.compose({
        threadId: ThreadId.make("t"),
        projectId: null,
        interactionMode: "default",
      });
      assert.isFalse(composed.text.includes("Torn down."));
    }),
  );
});

layer("PluginHost settings capability", (it) => {
  // A DEFAULTED field is what makes the corrupt-storage test honest. readDraft
  // never fails, so a corrupt row arrives as an empty draft; decoding `{}` against
  // this schema succeeds and yields the default. Without the guard the plugin is
  // handed `https://default.example` as if the user had configured it.
  const settingsEntry = `
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFs from "node:fs";

export const schema = Schema.Struct({
  endpoint: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("https://default.example"))),
});

export default {
  settings: { schema },
  register(hostApi) {
    return Effect.gen(function* () {
      const settings = yield* hostApi.settings;
      const dir = hostApi.config.dataDir;
      NodeFs.mkdirSync(dir, { recursive: true });
      // Record the OUTCOME rather than failing: an activation failure would be
      // indistinguishable from the many other reasons activation can fail.
      const outcome = yield* settings.get.pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, tag: error._tag, message: error.message }),
          onSuccess: (value) => ({ ok: true, value }),
        }),
      );
      NodeFs.writeFileSync(dir + "/settings-get.json", JSON.stringify(outcome));
      return {
        services: [
          {
            name: "watch-settings",
            run: () =>
              settings.changes.pipe(
                Stream.runForEach((value) =>
                  Effect.sync(() => {
                    NodeFs.appendFileSync(dir + "/settings-changes.jsonl", JSON.stringify(value) + "\\n");
                  }),
                ),
              ),
          },
        ],
      };
    });
  },
};
`;

  // Must match the plugin's schema exactly: the stored fingerprint has to be the
  // CURRENT one, or the drift check rejects the read and the corrupt-storage guard
  // under test never runs (the test would pass with the guard deleted).
  const pluginSchema = Schema.Struct({
    endpoint: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("https://default.example")),
    ),
  });
  const currentFingerprint = fingerprintSettingsSchema(pluginSchema);

  // The plugin records what it was handed; the test decodes it. Mirroring the
  // recorded shape as a schema keeps a malformed recording a decode failure rather
  // than an assertion that quietly compares `undefined` against `undefined`.
  const decodeGetOutcome = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Union([
        Schema.Struct({
          ok: Schema.Literal(true),
          value: Schema.Struct({ endpoint: Schema.String }),
        }),
        Schema.Struct({ ok: Schema.Literal(false), tag: Schema.String, message: Schema.String }),
      ]),
    ),
  );
  const decodeSettingsEvent = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ endpoint: Schema.String })),
  );

  const storeRow = (input: {
    readonly pluginId: PluginId;
    readonly valuesJson: string;
    readonly fingerprint: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO plugin_settings (plugin_id, values_json, schema_fingerprint, revision, updated_at)
        VALUES (${input.pluginId}, ${input.valuesJson}, ${input.fingerprint}, 1, 0)
      `;
    });

  const readGetOutcome = (pluginId: PluginId) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = pluginDataDir(config.pluginsDir, pluginId, path.join);
      const raw = yield* fs.readFileString(path.join(dir, "settings-get.json"));
      return yield* decodeGetOutcome(raw);
    });

  /** Poll until the subscriber has appended `count` events, or fail loudly. */
  const awaitChanges = (pluginId: PluginId, count: number) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(
        pluginDataDir(config.pluginsDir, pluginId, path.join),
        "settings-changes.jsonl",
      );
      const read = Effect.gen(function* () {
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        const lines = raw.split("\n").filter((line) => line.length > 0);
        if (lines.length < count) {
          return yield* Effect.fail({ _tag: "SettingsEventsPending" as const, seen: lines.length });
        }
        // Wrap rather than passing `decodeSettingsEvent` point-free: its second
        // parameter is decode OPTIONS, so forEach's index argument would land there.
        return yield* Effect.forEach(lines, (line) => decodeSettingsEvent(line));
      });
      // Retry WITHOUT delay, and bound it with `recurs`.
      //
      // `it.effect` runs on the TestClock, so anything clock-driven — `spaced`,
      // `Effect.timeout` — never advances: the poll simply hung until vitest's 120s
      // timeout, reporting nothing useful. (`it.live` is not available on the nested
      // `it` that `it.layer` hands back.) `recurs` never touches the clock; each
      // attempt yields, which is what lets the subscriber fiber make progress, and a
      // real failure surfaces in milliseconds with the event count it saw.
      return yield* read.pipe(Effect.retry({ schedule: Schedule.recurs(200) }), Effect.orDie);
    });

  it.effect(
    "fails the plugin's settings read rather than handing it defaults from a corrupt row",
    () =>
      Effect.gen(function* () {
        const pluginId = PluginId.make("settings-capability-corrupt");
        const host = yield* PluginHostModule.PluginHost;

        yield* runMigrations({});
        yield* installPlugin({
          pluginId,
          capabilities: ["settings"],
          entrySource: settingsEntry,
          webEntry: true,
        });
        // Valid JSON, but not an object — unreadable as settings. The CURRENT
        // fingerprint is stored deliberately, so the drift check cannot be what
        // rejects this read.
        yield* storeRow({
          pluginId,
          valuesJson: `"not-an-object"`,
          fingerprint: currentFingerprint,
        });
        yield* host.activatePlugin(pluginId);

        const outcome = yield* readGetOutcome(pluginId);
        assert.isFalse(
          outcome.ok,
          "a plugin must never be handed schema defaults derived from a row the host could not read",
        );
        assert.strictEqual(outcome.ok === false ? outcome.tag : "", "PluginSettingsInvalidStored");
        assert.notMatch(
          outcome.ok === false ? outcome.message : "",
          /not-an-object/,
          "the failure must not embed the stored values, which would leak configuration into logs",
        );
      }),
  );

  it.effect("keeps the changes stream alive when one event's read fails", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("settings-capability-changes");
      const host = yield* PluginHostModule.PluginHost;
      const settingsStore = yield* PluginSettingsStoreLayer.PluginSettingsStore;

      yield* runMigrations({});
      yield* installPlugin({
        pluginId,
        capabilities: ["settings"],
        entrySource: settingsEntry,
        webEntry: true,
      });
      yield* storeRow({
        pluginId,
        valuesJson: `{"endpoint":"https://one.example"}`,
        fingerprint: currentFingerprint,
      });
      yield* host.activatePlugin(pluginId);

      const initial = yield* readGetOutcome(pluginId);
      assert.isTrue(initial.ok, "a valid stored row must decode for the plugin");
      assert.strictEqual(
        initial.ok === true ? initial.value.endpoint : "",
        "https://one.example",
        "the plugin must receive the stored value, not the schema default",
      );

      yield* settingsStore.write({
        pluginId,
        values: { endpoint: "https://two.example" },
        schemaFingerprint: currentFingerprint,
        expectedRevision: 1,
      });
      // A write whose values were produced for a DIFFERENT schema shape: it reaches
      // the PubSub, but the subscriber's read fails the drift check. Under a
      // per-STREAM catch this event ends the subscription for the process lifetime.
      yield* settingsStore.write({
        pluginId,
        values: { endpoint: "https://drifted.example" },
        schemaFingerprint: "a-different-schema-shape",
        expectedRevision: 2,
      });
      yield* settingsStore.write({
        pluginId,
        values: { endpoint: "https://three.example" },
        schemaFingerprint: currentFingerprint,
        expectedRevision: 3,
      });

      const events = yield* awaitChanges(pluginId, 2);
      assert.deepStrictEqual(
        events.map((event) => event.endpoint),
        ["https://two.example", "https://three.example"],
        "the unreadable event must be skipped, and the write AFTER it must still arrive",
      );
    }),
  );
});
