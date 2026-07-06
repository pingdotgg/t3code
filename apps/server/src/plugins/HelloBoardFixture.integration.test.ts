import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes, PluginId, type AuthScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
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
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as PluginCatalogModule from "./PluginCatalog.ts";
import * as PluginHostModule from "./PluginHost.ts";
import * as PluginHttpRegistry from "./PluginHttpRegistry.ts";
import * as PluginInstallerModule from "./PluginInstaller.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import * as PluginManagementRpcHandlersModule from "./PluginManagementRpcHandlers.ts";
import * as PluginMarketplaceModule from "./PluginMarketplace.ts";
import * as PluginMigrator from "./PluginMigrator.ts";
import * as PluginModuleLoaderLayer from "./PluginModuleLoader.ts";
import * as PluginRpcDispatcherModule from "./PluginRpcDispatcher.ts";
import * as PluginRuntimeRegistryLayer from "./PluginRuntimeRegistry.ts";

const pluginId = PluginId.make("hello-board");
const fixtureRoot = decodeURIComponent(
  new URL("../../../../fixtures/hello-board", import.meta.url).pathname,
);

class HelloBoardFixtureBuildError extends Data.TaggedError("HelloBoardFixtureBuildError")<{
  readonly stdout: string;
  readonly stderr: string;
}> {}

const unexpectedCapabilityUse = () =>
  Effect.die(new Error("unexpected capability use in hello-board fixture test"));

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
  ),
);

const PluginRuntimeRegistryLayerLive = PluginRuntimeRegistryLayer.layer;
const PluginHttpRegistryLayerLive = PluginHttpRegistry.layer;
const PluginLockfileStoreLayerLive = PluginLockfileStoreLayer.layer;
const PluginHostCapabilityDepsLayerLive = Layer.mergeAll(
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: unexpectedCapabilityUse,
    set: unexpectedCapabilityUse,
    create: unexpectedCapabilityUse,
    getOrCreateRandom: unexpectedCapabilityUse,
    remove: unexpectedCapabilityUse,
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: unexpectedCapabilityUse(),
    getDescriptor: unexpectedCapabilityUse(),
  }),
  Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    dispatch: unexpectedCapabilityUse,
    streamDomainEvents: Stream.empty,
  }),
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
  Layer.mock(ProjectionThreadMessages.ProjectionThreadMessageRepository)({
    upsert: unexpectedCapabilityUse,
    getByMessageId: unexpectedCapabilityUse,
    listByThreadId: unexpectedCapabilityUse,
    deleteByThreadId: unexpectedCapabilityUse,
  }),
  Layer.mock(ProjectionThreadActivities.ProjectionThreadActivityRepository)({
    upsert: unexpectedCapabilityUse,
    listByThreadId: unexpectedCapabilityUse,
    deleteByThreadId: unexpectedCapabilityUse,
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: unexpectedCapabilityUse,
    listInstances: unexpectedCapabilityUse(),
    listUnavailable: unexpectedCapabilityUse(),
    streamChanges: Stream.empty,
    subscribeChanges: unexpectedCapabilityUse(),
  }),
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
  Layer.mock(CheckpointStore.CheckpointStore)({
    isGitRepository: unexpectedCapabilityUse,
    captureCheckpoint: unexpectedCapabilityUse,
    hasCheckpointRef: unexpectedCapabilityUse,
    restoreCheckpoint: unexpectedCapabilityUse,
    diffCheckpoints: unexpectedCapabilityUse,
    deleteCheckpointRefs: unexpectedCapabilityUse,
  }),
  Layer.mock(TextGeneration.TextGeneration)({
    generateCommitMessage: unexpectedCapabilityUse,
    generatePrContent: unexpectedCapabilityUse,
    generateBranchName: unexpectedCapabilityUse,
    generateThreadTitle: unexpectedCapabilityUse,
  }),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    get: unexpectedCapabilityUse,
    resolveHandle: unexpectedCapabilityUse,
    resolve: unexpectedCapabilityUse,
    discover: unexpectedCapabilityUse(),
  }),
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
);

const PluginHostLayerLive = PluginHostModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayerLive),
  Layer.provideMerge(PluginModuleLoaderLayer.layer),
  Layer.provideMerge(PluginMigrator.layer),
  Layer.provideMerge(PluginRuntimeRegistryLayerLive),
  Layer.provideMerge(PluginHttpRegistryLayerLive),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provideMerge(PluginHostCapabilityDepsLayerLive),
);
const PluginRpcDispatcherLayerLive = PluginRpcDispatcherModule.layer.pipe(
  Layer.provideMerge(PluginRuntimeRegistryLayerLive),
);
const PluginCatalogLayerLive = PluginCatalogModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayerLive),
  Layer.provideMerge(PluginRuntimeRegistryLayerLive),
);
const PluginMarketplaceLayerLive = PluginMarketplaceModule.layer;
const PluginInstallerLayerLive = PluginInstallerModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayerLive),
  Layer.provideMerge(PluginMarketplaceLayerLive),
  Layer.provideMerge(PluginHostLayerLive),
  Layer.provideMerge(PluginCatalogLayerLive),
);
const PluginManagementRpcHandlersLayerLive = PluginManagementRpcHandlersModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayerLive),
  Layer.provideMerge(PluginMarketplaceLayerLive),
  Layer.provideMerge(PluginInstallerLayerLive),
);
const PluginLayerLive = Layer.mergeAll(
  PluginHostLayerLive,
  PluginRpcDispatcherLayerLive,
  PluginCatalogLayerLive,
  PluginMarketplaceLayerLive,
  PluginInstallerLayerLive,
  PluginManagementRpcHandlersLayerLive,
  PluginHttpRegistryLayerLive,
  PluginLockfileStoreLayerLive,
);

const testLayer = PluginLayerLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hello-board-fixture-" })),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(TestClock.layer()),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(testLayer);

const session = (scopes: ReadonlyArray<AuthScope>) => ({ scopes });

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function buildFixture(outDir: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("pnpm", ["--dir", fixtureRoot, "run", "build", "--", "--out-dir", outDir], {
        cwd: fixtureRoot,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectText(child.stdout),
        collectText(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new HelloBoardFixtureBuildError({ stdout, stderr });
    }
  }).pipe(Effect.scoped);
}

function linkHostPluginExternals(pluginsDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nodeModules = path.join(pluginsDir, "node_modules");
    yield* fs.makeDirectory(path.join(nodeModules, "@t3tools"), { recursive: true });
    const links = [
      {
        from: path.resolve(import.meta.dirname, "../../../../packages/plugin-sdk"),
        to: path.join(nodeModules, "@t3tools/plugin-sdk"),
      },
      {
        from: path.resolve(import.meta.dirname, "../../node_modules/effect"),
        to: path.join(nodeModules, "effect"),
      },
    ];
    for (const link of links) {
      yield* fs.remove(link.to, { force: true, recursive: true });
      yield* fs.symlink(link.from, link.to);
    }
  });
}

const withPluginDev = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({
      pluginDev: process.env.T3_PLUGIN_DEV,
      healthyDelay: process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS,
    })),
    () =>
      Effect.sync(() => {
        process.env.T3_PLUGIN_DEV = "1";
        process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = "0";
      }).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous.pluginDev === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous.pluginDev;
        }
        if (previous.healthyDelay === undefined) {
          delete process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS;
        } else {
          process.env.T3_PLUGIN_HOST_HEALTHY_DELAY_MS = previous.healthyDelay;
        }
      }),
  );

layer("hello-board fixture plugin", (it) => {
  it.effect("installs, activates, runs migrations, and round-trips plugin RPC", () =>
    withPluginDev(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sql = yield* SqlClient.SqlClient;
          const handlers = yield* PluginManagementRpcHandlersModule.PluginManagementRpcHandlers;
          const catalog = yield* PluginCatalogModule.PluginCatalog;
          const dispatcher = yield* PluginRpcDispatcherModule.PluginRpcDispatcher;
          const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "hello-board-fixture-" });
          const config = yield* ServerConfig.ServerConfig;

          yield* buildFixture(outDir);
          yield* linkHostPluginExternals(config.pluginsDir);
          yield* runMigrations({ toMigrationInclusive: 34 });

          const marketplaceUrl = new URL(`file://${path.join(outDir, "marketplace.json")}`).href;
          const source = yield* handlers.addSource({ url: marketplaceUrl });
          const catalogResult = yield* handlers.catalog({ sourceId: source.source.id });
          assert.equal(catalogResult.entries[0]?.id, pluginId);

          const staged = yield* handlers.beginInstall({
            sourceId: source.source.id,
            pluginId,
            version: "1.0.0",
          });
          assert.equal(staged.manifest.id, pluginId);
          assert.property(staged.capabilityDescriptions, "database");

          const confirmed = yield* handlers.confirmInstall(staged.stageToken);
          assert.equal(confirmed.plugin.id, pluginId);

          const installed = yield* catalog.list;
          assert.deepInclude(
            installed.map((plugin) => ({
              id: plugin.id,
              state: plugin.state,
              hasWeb: plugin.hasWeb,
              capabilities: plugin.capabilities,
              lastError: plugin.lastError,
            })),
            {
              id: pluginId,
              state: "active",
              hasWeb: true,
              capabilities: ["database"],
              lastError: null,
            },
          );

          const added = (yield* dispatcher.call(
            pluginId,
            "addNote",
            { body: "hello from fixture" },
            session(AuthStandardClientScopes),
          )) as { readonly body?: unknown };
          assert.equal(added.body, "hello from fixture");

          const notes = (yield* dispatcher.call(
            pluginId,
            "listNotes",
            {},
            session(AuthStandardClientScopes),
          )) as ReadonlyArray<{ readonly body?: unknown }>;
          assert.equal(notes[0]?.body, "hello from fixture");

          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p_hello_board_notes'
          `;
          assert.deepEqual(tables, [{ name: "p_hello_board_notes" }]);
        }),
      ),
    ),
  );
});
