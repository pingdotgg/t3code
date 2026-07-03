import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, ProjectId } from "@t3tools/contracts";
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

import {
  OWNED_INDEXES,
  OWNED_TABLES,
} from "../../../../fixtures/workflow-boards/server/migrations/renameMap.ts";
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

const pluginId = PluginId.make("workflow-boards");
const WORKSPACE_ROOT_ENV = "T3_WORKFLOW_BOARDS_WORKSPACE_ROOT";
const fixtureRoot = decodeURIComponent(
  new URL("../../../../fixtures/workflow-boards", import.meta.url).pathname,
);

const LEGACY_TABLE_NAMES = [
  "workflow_events",
  "projection_board",
  "projection_ticket",
  "projection_pipeline_run",
  "projection_step_run",
  "projection_ticket_message",
  "projection_ticket_dependency",
  "worktree_lease",
  "workflow_dispatch_outbox",
  "workflow_setup_run",
  "workflow_project_trust",
  "workflow_script_run",
  "workflow_board_version",
  "workflow_board_webhook",
  "workflow_webhook_delivery",
  "workflow_pr_state",
  "workflow_pr_observation",
  "workflow_notification_outbox",
  "work_source_connection",
  "work_source_mapping",
  "work_source_state",
  "workflow_outbound_connection",
  "workflow_outbound_delivery",
  "workflow_board_proposal",
  "workflow_agent_session",
] as const;

// Exact column count per ported table (the faithful baseline). A dropped/added
// column changes the count and fails the shape guard. dispatch_outbox = 17 (13
// base + 4 folded ALTER columns); step_run = 20; ticket = 19.
const EXPECTED_TABLE_COLUMN_COUNTS: Readonly<Record<string, number>> = {
  p_workflow_boards_agent_session: 6,
  p_workflow_boards_board_proposal: 12,
  p_workflow_boards_board_version: 6,
  p_workflow_boards_board_webhook: 4,
  p_workflow_boards_dispatch_outbox: 17,
  p_workflow_boards_events: 7,
  p_workflow_boards_outbound_connection: 5,
  p_workflow_boards_outbound_delivery: 13,
  p_workflow_boards_pr_observation: 9,
  p_workflow_boards_pr_state: 12,
  p_workflow_boards_project_trust: 2,
  p_workflow_boards_projection_board: 6,
  p_workflow_boards_projection_pipeline_run: 7,
  p_workflow_boards_projection_step_run: 20,
  p_workflow_boards_projection_ticket: 19,
  p_workflow_boards_projection_ticket_dependency: 2,
  p_workflow_boards_projection_ticket_message: 8,
  p_workflow_boards_script_run: 10,
  p_workflow_boards_setup_run: 7,
  p_workflow_boards_webhook_delivery: 3,
  p_workflow_boards_work_source_connection: 8,
  p_workflow_boards_work_source_mapping: 13,
  p_workflow_boards_work_source_state: 7,
  p_workflow_boards_worktree_lease: 6,
};

class WorkflowBoardsFixtureBuildError extends Data.TaggedError("WorkflowBoardsFixtureBuildError")<{
  readonly stdout: string;
  readonly stderr: string;
}> {}

const unexpectedCapabilityUse = () =>
  Effect.die(new Error("unexpected capability use in workflow-boards fixture test"));

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
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 1,
        updatedAt: "2026-07-03T00:00:00.000Z",
        projects: [
          {
            id: ProjectId.make("workflow-boards-project"),
            title: "Workflow Boards Project",
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
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-boards-fixture-" }),
  ),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(TestClock.layer()),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(testLayer);

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
      return yield* new WorkflowBoardsFixtureBuildError({ stdout, stderr });
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

layer("workflow-boards fixture plugin", (it) => {
  it.effect("installs, activates, runs migrations, and creates namespaced schema", () =>
    withPluginDev(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sql = yield* SqlClient.SqlClient;
          const handlers = yield* PluginManagementRpcHandlersModule.PluginManagementRpcHandlers;
          const catalog = yield* PluginCatalogModule.PluginCatalog;
          const outDir = yield* fs.makeTempDirectoryScoped({
            prefix: "workflow-boards-fixture-",
          });
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "workflow-boards-workspace-",
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
            version: "0.1.0",
          });
          assert.equal(staged.manifest.id, pluginId);
          assert.deepEqual(Object.keys(staged.capabilityDescriptions).sort(), ["database"]);

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
              hasWeb: false,
              capabilities: ["database"],
              lastError: null,
            },
          );

          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'p_workflow_boards_%'
            ORDER BY name
          `;
          const tableNames = tables.map((row) => row.name);
          for (const owned of OWNED_TABLES) {
            assert.include(tableNames, owned);
          }
          assert.equal(tableNames.length, OWNED_TABLES.length);

          const indexes = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'p_workflow_boards_%'
            ORDER BY name
          `;
          const indexNames = indexes.map((row) => row.name);
          for (const owned of OWNED_INDEXES) {
            assert.include(indexNames, owned);
          }
          assert.equal(indexNames.length, OWNED_INDEXES.length);

          const allTables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table'
          `;
          const legacyNames = new Set<string>(LEGACY_TABLE_NAMES);
          const legacy = allTables.filter((row) => legacyNames.has(row.name));
          assert.equal(legacy.length, 0);

          // --- Column-shape guard (schema faithfulness, not just object names).
          // Names + counts alone would false-pass a dropped/retyped column or a
          // removed DEFAULT/UNIQUE/partial-WHERE — the exact regression class that
          // only surfaces once the read model (A1b) or engine (A3) reads/writes
          // these tables. Assert exact per-table column counts + the highest-risk
          // constraints (the 4 folded dispatch_outbox columns, key DEFAULTs/UNIQUEs,
          // and the partial pr_state index). Counts are generated from the faithful
          // baseline; they change only on a deliberate schema edit.
          for (const [table, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMN_COUNTS)) {
            const columns = yield* sql.unsafe<{ readonly name: string }>(
              `SELECT name FROM pragma_table_info('${table}')`,
            );
            assert.equal(columns.length, expectedColumns, `column count for ${table}`);
          }

          const ddlRows = yield* sql<{ readonly name: string; readonly sql: string }>`
            SELECT name, sql FROM sqlite_master
            WHERE name LIKE 'p_workflow_boards_%' AND sql IS NOT NULL
          `;
          const ddlByName = new Map(ddlRows.map((row) => [row.name, row.sql]));
          const assertDdlIncludes = (name: string, needle: string) =>
            assert.include(ddlByName.get(name) ?? "", needle, `${name} DDL missing: ${needle}`);
          // The 4 dispatch_outbox ALTER columns must be folded inline.
          assertDdlIncludes("p_workflow_boards_dispatch_outbox", "options_json");
          assertDdlIncludes("p_workflow_boards_dispatch_outbox", "project_id");
          assertDdlIncludes("p_workflow_boards_dispatch_outbox", "thread_title");
          assertDdlIncludes("p_workflow_boards_dispatch_outbox", "runtime_mode");
          // High-risk DEFAULT / UNIQUE / partial-index constraints.
          assertDdlIncludes("p_workflow_boards_pr_state", "DEFAULT 'open'");
          assertDdlIncludes("p_workflow_boards_events", "UNIQUE");
          assertDdlIncludes("p_workflow_boards_work_source_mapping", "DEFAULT 'active'");
          assertDdlIncludes(
            "p_workflow_boards_outbound_delivery",
            "UNIQUE (event_sequence, rule_id)",
          );
          assertDdlIncludes(
            "p_workflow_boards_idx_workflow_pr_state_open",
            "WHERE pr_state = 'open'",
          );

          // The migrator recorded the applied migration.
          const migrationRows = yield* sql<{
            readonly version: number;
            readonly name: string;
          }>`
            SELECT version, name FROM plugin_migrations
            WHERE plugin_id = ${pluginId}
            ORDER BY version
          `;
          assert.equal(migrationRows.length, 1);
          assert.equal(migrationRows[0]?.version, 1);
          assert.equal(migrationRows[0]?.name, "workflow_schema");
        }),
      ),
    ),
  );
});
