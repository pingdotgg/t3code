import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes, PluginId, ProjectId, type AuthScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
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
import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { OutboundUrlError, OutboundUrlLookup } from "./OutboundUrlValidator.ts";
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
import * as PluginContextComposerLayer from "./PluginContextComposer.ts";
import * as PluginSettingsStoreLayer from "./PluginSettingsStore.ts";
import * as PluginToolCatalogLayer from "./PluginToolCatalog.ts";

const pluginId = PluginId.make("hello-board");
const WORKSPACE_ROOT_ENV = "T3_HELLO_BOARD_WORKSPACE_ROOT";
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
const TestOutboundLookupLive = Layer.succeed(OutboundUrlLookup, (host: string) =>
  host === "fixture.test"
    ? Effect.succeed([{ address: "140.82.112.3", family: 4 as const }])
    : Effect.fail(new OutboundUrlError({ reason: `unexpected lookup ${host}` })),
);
const TestPluginHttpClientTransportLive = Layer.succeed(
  PluginHttpClientTransportService,
  (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        HttpClientRequest.make(request.method as "GET")(request.url.toString()),
        new Response("hello http", { status: 200 }),
      ),
    ),
);

const PluginRuntimeRegistryLayerLive = PluginRuntimeRegistryLayer.layer;
const PluginLockfileStoreLayerLive = PluginLockfileStoreLayer.layer;
const PluginToolCatalogLayerLive = PluginToolCatalogLayer.layer.pipe(
  Layer.provide(PluginRuntimeRegistryLayerLive),
  Layer.provideMerge(PluginLockfileStoreLayerLive),
);
const PluginHttpRegistryLayerLive = PluginHttpRegistry.layer;
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
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 1,
        updatedAt: "2026-07-03T00:00:00.000Z",
        projects: [
          {
            id: ProjectId.make("hello-board-project"),
            title: "Hello Board Project",
            workspaceRoot: process.env[WORKSPACE_ROOT_ENV] ?? process.cwd(),
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-07-03T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
        ],
        threads: [],
      })),
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
    mergePullRequest: unexpectedCapabilityUse,
    getPullRequestDetail: unexpectedCapabilityUse,
    listPullRequestChecks: unexpectedCapabilityUse,
    listPullRequestReviews: unexpectedCapabilityUse,
    listPullRequestReviewComments: unexpectedCapabilityUse,
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
  TestOutboundLookupLive,
  TestPluginHttpClientTransportLive,
);

const PluginHostLayerLive = PluginHostModule.layer.pipe(
  Layer.provideMerge(PluginLockfileStoreLayerLive),
  Layer.provideMerge(PluginModuleLoaderLayer.layer),
  Layer.provideMerge(PluginMigrator.layer),
  Layer.provideMerge(PluginRuntimeRegistryLayerLive),
  Layer.provideMerge(PluginToolCatalogLayerLive),
  Layer.provideMerge(PluginSettingsStoreLayer.layer),
  Layer.provideMerge(PluginContextComposerLayer.layer),
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
// The marketplace fetches untrusted URLs through the SSRF guard, so it
// needs the same lookup + pinned-transport test stubs as the capability.
const PluginMarketplaceLayerLive = PluginMarketplaceModule.layer.pipe(
  Layer.provide(Layer.mergeAll(TestOutboundLookupLive, TestPluginHttpClientTransportLive)),
);
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
  PluginToolCatalogLayerLive,
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
      workspaceRoot: process.env[WORKSPACE_ROOT_ENV],
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
        if (previous.workspaceRoot === undefined) {
          delete process.env[WORKSPACE_ROOT_ENV];
        } else {
          process.env[WORKSPACE_ROOT_ENV] = previous.workspaceRoot;
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
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "hello-board-workspace-",
          });
          const config = yield* ServerConfig.ServerConfig;
          process.env[WORKSPACE_ROOT_ENV] = workspaceRoot;

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
          assert.property(staged.capabilityDescriptions, "filesystem");
          assert.property(staged.capabilityDescriptions, "httpClient");
          assert.property(staged.capabilityDescriptions, "tools");
          assert.match(staged.capabilityDescriptions.tools ?? "", /blanket grant/i);

          const confirmed = yield* handlers.confirmInstall(staged.stageToken);
          assert.equal(confirmed.plugin.id, pluginId);

          const installed = yield* catalog.list;
          assert.deepInclude(
            installed.map((plugin) => ({
              id: plugin.id,
              state: plugin.state,
              hasWeb: plugin.hasWeb,
              hasStyles: plugin.hasStyles,
              capabilities: plugin.capabilities,
              lastError: plugin.lastError,
            })),
            {
              id: pluginId,
              state: "active",
              hasWeb: true,
              hasStyles: false,
              capabilities: ["database", "filesystem", "httpClient", "tools", "settings"],
              lastError: null,
            },
          );

          const toolCatalog = yield* PluginToolCatalogLayer.PluginToolCatalog;
          const finalToolName = "plugin_hello_board__echo_note";
          // Host reserves tools on activation; MCP registration sets active when
          // the runtime is put. In this fixture harness the MCP toolkit is not
          // mounted, so activate manually to exercise the trampoline call path.
          yield* toolCatalog.activate(pluginId);
          assert.equal(toolCatalog.isActive(finalToolName), true);

          const echo = yield* toolCatalog.makeTrampolineHandle(
            pluginId,
            "echo_note",
          )({
            message: "from-agent",
          });
          assert.equal(echo.isError, false);
          assert.deepEqual(echo.content, [{ type: "text", text: "hello-board: from-agent" }]);
          assert.deepEqual(echo.structuredContent, {
            echoed: "from-agent",
            plugin: "hello-board",
          });

          // Disable → call-time gate fails closed (and visibility drops).
          yield* handlers.setEnabled({ pluginId, enabled: false });
          assert.equal(toolCatalog.isActive(finalToolName), false);
          const disabledCall = yield* toolCatalog.makeTrampolineHandle(
            pluginId,
            "echo_note",
          )({
            message: "should-not-run",
          });
          assert.equal(disabledCall.isError, true);
          const disabledText =
            disabledCall.content[0]?.type === "text" ? disabledCall.content[0].text : "";
          assert.match(disabledText, /not enabled/i);

          // Re-enable → callable again, still a single reserved permanent entry.
          yield* handlers.setEnabled({ pluginId, enabled: true });
          yield* toolCatalog.activate(pluginId);
          assert.equal(toolCatalog.isActive(finalToolName), true);
          const reenabled = yield* toolCatalog.makeTrampolineHandle(
            pluginId,
            "echo_note",
          )({
            message: "again",
          });
          assert.equal(reenabled.isError, false);
          assert.deepEqual(reenabled.content, [{ type: "text", text: "hello-board: again" }]);
          const permanent = yield* toolCatalog.getPermanent(finalToolName);
          assert.equal(permanent._tag, "Some");
          if (permanent._tag === "Some") {
            assert.equal(permanent.value.pluginId, pluginId);
            assert.equal(permanent.value.localName, "echo_note");
          }

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

          const capabilityResult = (yield* dispatcher.call(
            pluginId,
            "exerciseCapabilities",
            {},
            session(AuthStandardClientScopes),
          )) as {
            readonly file?: unknown;
            readonly status?: unknown;
            readonly body?: unknown;
          };
          assert.deepEqual(capabilityResult, {
            file: "hello filesystem",
            status: 200,
            body: "hello http",
          });
          assert.equal(
            yield* fs.readFileString(path.join(workspaceRoot, ".hello-board", "capability.txt")),
            "hello filesystem",
          );

          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p_hello_board_notes'
          `;
          assert.deepEqual(tables, [{ name: "p_hello_board_notes" }]);
        }),
      ),
    ),
  );
});
