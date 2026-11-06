import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DefaultBranchPolicy from "./DefaultBranchPolicy.ts";

const layer = DefaultBranchPolicy.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "isolates project defaults, resolves worktrees through their repository, and resets immediately",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const policy = yield* DefaultBranchPolicy.DefaultBranchPolicy;
      const readOverride = (input: {
        cwd: string;
        worktreeRoot: string | null;
        repositoryRoot: string;
      }) => policy.getOverride({ cwd: input.cwd, repository: Effect.succeed(input) });
      const sql = yield* SqlClient.SqlClient;
      const first = ProjectId.make("first");
      const second = ProjectId.make("second");
      const nested = ProjectId.make("nested");
      for (const projectId of [first, second, nested]) {
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make(`create-${projectId}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-11-06T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: projectId,
            workspaceRoot:
              projectId === nested ? "/projects/first/nested" : `/projects/${projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-11-06T00:00:00.000Z",
            updatedAt: "2026-11-06T00:00:00.000Z",
          },
        });
      }
      const root = {
        cwd: "/projects/first",
        worktreeRoot: "/projects/first",
        repositoryRoot: "/projects/first",
      };
      const worktree = {
        ...root,
        cwd: "/worktrees/feature/subdir",
        worktreeRoot: "/worktrees/feature",
      };
      assert.isNull(yield* readOverride(root));
      yield* settings.updateSettings({
        projectSettingsOverrides: { [first]: { defaultBranch: "release/v2" } },
      });
      assert.equal(yield* readOverride(root), "release/v2");
      assert.equal(yield* readOverride(worktree), "release/v2");
      yield* settings.updateSettings({
        projectSettingsOverrides: { [nested]: { defaultBranch: "topic/base" } },
      });
      assert.equal(
        yield* readOverride({ ...root, cwd: "/projects/first/nested/src" }),
        "topic/base",
      );
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        'worktree-thread', ${first}, 'Worktree', 'codex', 'full-access', 'default',
        '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00.000Z',
        ${JSON.stringify({ worktreePath: "/worktrees/feature" })}
      )
    `;
      assert.equal(
        yield* readOverride({ ...worktree, repositoryRoot: "/projects/unregistered" }),
        "release/v2",
      );
      assert.isNull(
        yield* readOverride({
          cwd: "/projects/second",
          worktreeRoot: "/projects/second",
          repositoryRoot: "/projects/second",
        }),
      );
      yield* settings.updateSettings({
        projectSettingsOverrides: { [first]: { defaultBranch: "develop" } },
      });
      assert.equal(yield* readOverride(worktree), "develop");
      yield* settings.updateSettings({
        projectSettingsOverrides: { [first]: { defaultBranch: null } },
      });
      assert.isNull(yield* readOverride(worktree));
    }).pipe(Effect.provide(layer)),
);
