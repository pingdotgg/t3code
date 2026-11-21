import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("keeps pin and archive times across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 1,
          eventId: EventId.make("event-organized-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Organized",
            workspaceRoot: "/tmp/project-organized",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 2,
          eventId: EventId.make("event-organized-pinned"),
          type: "project.meta-updated",
          payload: { projectId, pinnedAt: at, archivedAt: at, updatedAt: at },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 3,
          eventId: EventId.make("event-organized-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: at },
        });
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.strictEqual(project?.pinnedAt, at);
        assert.strictEqual(project?.archivedAt, at);
      }),
    );

    it.effect("lists each provider session with its thread's project", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const project = (id: string, title: string) =>
          sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
            VALUES (${id}, ${title}, ${`/work/${id}`}, '[]', '2026-08-01', '2026-08-01')`;
        const thread = (id: string, projectId: string) =>
          sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${id}, ${projectId}, ${id}, 'claudeAgent', 'full-access', 'default', '2026-08-01', '2026-08-01', '{}')`;
        const binding = (id: string, threadId: string, nativeId: string | null) =>
          sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, driver, status, updated_at, payload_json)
            VALUES (${id}, ${threadId}, 'claudeAgent', 'claudeAgent', 'idle', '2026-08-01', ${JSON.stringify(
              { nativeThreadRef: nativeId === null ? null : { driver: "claudeAgent", nativeId } },
            )})`;
        const attempt = (
          id: string,
          threadId: string,
          providerThreadId: string,
          nativeThreadId?: string,
        ) =>
          sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
            VALUES (${id}, ${threadId}, ${id}, 1, ${id}, 'claudeAgent', ${providerThreadId}, 'completed', ${JSON.stringify(
              { nativeThreadId },
            )})`;

        yield* project("p-app", "App");
        yield* project("p-other", "Other");
        yield* thread("t-main", "p-app");
        yield* thread("t-worktree", "p-app");
        yield* thread("t-other", "p-other");
        yield* binding("pt-main", "t-main", "bound");
        yield* binding("pt-worktree", "t-worktree", "worktree");
        yield* binding("pt-ambiguous-app", "t-main", "ambiguous");
        yield* binding("pt-ambiguous-other", "t-other", "ambiguous");
        yield* binding("pt-forgotten", "t-worktree", null);
        yield* attempt("a-old", "t-main", "pt-main", "before-recovery");
        yield* attempt("a-old-again", "t-main", "pt-main", "before-recovery");
        yield* attempt("a-current", "t-main", "pt-main", "bound");
        yield* attempt("a-forgotten", "t-worktree", "pt-forgotten", "forgotten");
        yield* attempt("a-no-native", "t-main", "pt-main");
        yield* sql`UPDATE projection_projects SET deleted_at = '2026-08-02' WHERE project_id = 'p-app'`;

        const rows = yield* projects.listProviderSessionProjects();
        assert.deepStrictEqual(
          rows.map((row) => `${row.nativeId} ${row.projectId} ${row.title}`).sort(),
          [
            "ambiguous p-app App",
            "ambiguous p-other Other",
            "before-recovery p-app App",
            "bound p-app App",
            "forgotten p-app App",
            "worktree p-app App",
          ],
        );
      }),
    );

    it.effect("marks a project's title as custom only once it is renamed", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-renamed");
        const event = {
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as const;
        const hasCustomTitle = () =>
          projects
            .getShell(projectId)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.hasCustomTitle));
        yield* projects.apply({
          ...event,
          sequence: 1,
          eventId: EventId.make("event-renamed-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), false);
        yield* projects.apply({
          ...event,
          sequence: 2,
          eventId: EventId.make("event-renamed-title"),
          type: "project.meta-updated",
          payload: { projectId, title: "custom repo", updatedAt: "2026-03-24T00:00:02.000Z" },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        yield* projects.apply({
          ...event,
          sequence: 3,
          eventId: EventId.make("migration:39:project:project-renamed:baseline"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:03.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(projectId))?.title,
          "custom repo",
        );
      }),
    );
  },
);
