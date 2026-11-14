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
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.deepStrictEqual(project?.defaultModelSelection, modelSelection);
        // Events from before tracked folders have no list.
        assert.deepStrictEqual(project?.trackedFolders, []);
      }),
    );

    it.effect("keeps pin and archive times and tracked folders across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        const trackedFolders = [{ path: "/tmp/project-shared", name: "Shared" }];
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
          payload: { projectId, pinnedAt: at, archivedAt: at, trackedFolders, updatedAt: at },
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
        assert.deepStrictEqual(project?.trackedFolders, trackedFolders);
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
