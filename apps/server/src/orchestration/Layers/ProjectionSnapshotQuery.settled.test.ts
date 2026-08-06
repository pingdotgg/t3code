import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ModelSelection, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const encodeModelSelectionJson = Schema.encodeUnknownEffect(Schema.fromJsonString(ModelSelection));

it.effect(
  "decodes null settlement values for legacy projection_threads rows across snapshot readers",
  () =>
    Effect.gen(function* () {
      const metadataLayer = Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) =>
            Effect.succeed({
              canonicalKey: "example.test/legacy-settled",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://example.test/legacy-settled.git",
              },
              rootPath: workspaceRoot,
            }),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
      );
      const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provideMerge(ProjectEnrichment.layer),
        Layer.provideMerge(metadataLayer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "projection-snapshot-query-settled-test-",
          }),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const projectId = ProjectId.make("project:legacy-settled");
        const threadId = ThreadId.make("thread:legacy-settled");
        const now = "2026-06-01T00:00:00.000Z";
        const modelSelectionJson = yield* encodeModelSelectionJson({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        });

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          ) VALUES (
            ${projectId},
            ${"Legacy settled project"},
            ${"/work/legacy-settled"},
            NULL,
            ${"[]"},
            ${now},
            ${now},
            NULL
          )
        `;

        // Post-migration 041 shape: columns exist, legacy rows leave them NULL.
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            settled_override,
            settled_at,
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            deleted_at
          ) VALUES (
            ${threadId},
            ${projectId},
            ${"Legacy settled thread"},
            ${modelSelectionJson},
            ${"full-access"},
            ${"default"},
            NULL,
            NULL,
            NULL,
            ${now},
            ${now},
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
        `;

        const command = yield* query.getCommandReadModel();
        const commandThread = command.threads.find((thread) => thread.id === threadId);
        assert.ok(commandThread, "expected command read model to include legacy thread");
        assert.isNull(commandThread.settledOverride);
        assert.isNull(commandThread.settledAt);

        const shell = yield* query.getShellSnapshot();
        const shellThread = shell.threads.find((thread) => thread.id === threadId);
        assert.ok(shellThread, "expected shell snapshot to include legacy thread");
        assert.isNull(shellThread.settledOverride);
        assert.isNull(shellThread.settledAt);

        const byId = yield* query.getThreadShellById(threadId);
        assert.isTrue(Option.isSome(byId), "expected by-id shell read for legacy thread");
        const byIdThread = Option.getOrThrow(byId);
        assert.isNull(byIdThread.settledOverride);
        assert.isNull(byIdThread.settledAt);

        yield* sql`
          UPDATE projection_threads
          SET archived_at = ${now}
          WHERE thread_id = ${threadId}
        `;
        const archived = yield* query.getArchivedShellSnapshot();
        const archivedThread = archived.threads.find((thread) => thread.id === threadId);
        assert.ok(archivedThread, "expected archived shell snapshot to include legacy thread");
        assert.isNull(archivedThread.settledOverride);
        assert.isNull(archivedThread.settledAt);
      }).pipe(Effect.provide(testLayer));
    }),
);
