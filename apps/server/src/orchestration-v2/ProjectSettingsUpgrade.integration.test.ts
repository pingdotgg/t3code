import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorktreeRevivalServiceTestkit from "../vcs/WorktreeRevivalService.testkit.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const projectId = ProjectId.make("project:upgrade");
const icon = { kind: "emoji", emoji: "🦊" } as const;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const expectedSettings = {
  default_thread_env_mode: "worktree",
  auto_pull: 1,
  favicon_path: "brand/icon.svg",
  project_icon_json: encodeJson(icon),
};

const readSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<typeof expectedSettings>`
    SELECT default_thread_env_mode, auto_pull, favicon_path, project_icon_json
    FROM projection_projects
    WHERE project_id = ${projectId}
  `;
  return rows[0];
});

/** A released V1 database at migration 54 whose project carries all four settings. */
const seedV1Database = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  const events = [
    {
      type: "project.created",
      payload: {
        projectId,
        title: "Upgrade",
        workspaceRoot: "/work/upgrade",
        defaultModelSelection: null,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "project.meta-updated",
      payload: {
        projectId,
        defaultThreadEnvMode: "worktree",
        autoPull: true,
        faviconPath: "brand/icon.svg",
        projectIcon: icon,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    },
  ] as const;
  for (const [version, event] of events.entries()) {
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (
        ${`v1:${event.type}`}, 'project', ${projectId}, ${version}, ${event.type},
        ${event.payload.updatedAt}, ${`command:${event.type}`}, NULL, ${`command:${event.type}`},
        'client', ${encodeJson(event.payload)}, '{}'
      )
    `;
  }
  // The V1 projector had applied both events before the upgrade.
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, default_thread_env_mode,
      auto_pull, favicon_path, project_icon_json, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Upgrade', '/work/upgrade', NULL, ${expectedSettings.default_thread_env_mode},
      1, ${expectedSettings.favicon_path}, ${expectedSettings.project_icon_json}, '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('projection.projects', 2, '2026-01-02T00:00:00.000Z')
  `;
});

const unusedEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: false,
};

/** The production V2 runtime and project service against one file-backed database. */
const layerRuntime = (dbPath: string) => {
  const layerPlatform = Layer.merge(
    NodeServices.layer,
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  );
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-project-upgrade-",
  });
  const layerCheckpointStore = CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatform),
      ),
    ),
  );
  return Layer.mergeAll(
    RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
    RuntimeLayer.layerProjectService,
  ).pipe(
    Layer.provide(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        peek: () => Effect.succeed(unusedEnrichment),
        getAvailable: () => Effect.succeed(unusedEnrichment),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
    Layer.provide(layerCheckpointStore),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
      }),
    ),
    Layer.provide(WorktreeRevivalServiceTestkit.layerNoop),
    Layer.provide(layerPlatform),
  );
};

it.live("keeps project settings through the V2 migrations and the first V2 boot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-upgrade-" });
      const dbPath = path.join(stateDir, "statev2.sqlite");

      // Seed the released V1 schema, then boot the V2 runtime, which runs 055+, on the same file.
      yield* seedV1Database.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).reconcileShells;
        assert.deepEqual(yield* readSettings, expectedSettings);
        const project = yield* (yield* ProjectService.ProjectService).getById(projectId);
        assert.equal(project._tag, "Some");
      }).pipe(Effect.provide(layerRuntime(dbPath)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
