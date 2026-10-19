import { assert, it } from "@effect/vitest";
import { OrchestrationV2AppThreadJson, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import { runMigrations } from "../Migrations.ts";

const decodeThread = Schema.decodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const updatedAt = "2026-09-01T00:00:00.000Z";
const linked = {
  projectId: "project-1",
  repository: "Acme/Web",
  number: 42,
  url: "https://github.com/acme/web/pull/42",
};
const currentLink = {
  host: "github.com",
  repository: "acme/web",
  number: 43,
  url: "https://github.com/acme/web/pull/43",
  source: "agent" as const,
  linkedAt: updatedAt,
  snapshot: null,
  stack: null,
};
const thread = (id: string) => ({
  id,
  projectId: "project-1",
  title: id,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  deletedAt: null,
});

const layer = it.layer(
  ProjectionMaintenance.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);

layer("064_CanonicalizeThreadPullRequestLinks", (it) => {
  it.effect("migrates single links once, preserves arrays, and keeps links after a rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const fixtures = [
        { ...thread("github"), linkedPullRequest: linked },
        {
          ...thread("forgejo"),
          linkedPullRequest: { ...linked, url: "http://forge.example:3000/acme/web/pulls/42" },
        },
        {
          ...thread("azure"),
          linkedPullRequest: {
            ...linked,
            repository: "project/_git/web",
            url: "https://dev.azure.com/org/project/_git/web/pullrequest/42",
          },
        },
        { ...thread("empty"), linkedPullRequest: linked, pullRequests: [] },
        { ...thread("current"), linkedPullRequest: linked, pullRequests: [currentLink] },
        { ...thread("unlinked"), linkedPullRequest: null },
        ...Array.from({ length: 501 }, (_, index) => ({
          ...thread(`page-${String(index).padStart(3, "0")}`),
          linkedPullRequest: {
            ...linked,
            number: 9000,
            url: "https://github.com/acme/web/pull/9000",
          },
        })),
      ];
      for (const fixture of fixtures) {
        const payload = JSON.stringify(fixture);
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${fixture.id}, 'project-1', ${fixture.title}, 'codex', 'full-access', 'default',
            ${updatedAt}, ${updatedAt}, ${payload}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${`event:${fixture.id}`}, 'thread', ${fixture.id}, 0, 'thread.created', ${updatedAt},
            'user', ${payload}, '{}', 2
          )
        `;
      }
      const v1Payload = JSON.stringify({ linkedPullRequest: linked });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES ('event:v1', 'thread', 'v1', 0, 'thread.created', ${updatedAt},
          'user', ${v1Payload}, '{}', 1)
      `;

      assert.deepEqual(yield* runMigrations(), [[64, "CanonicalizeThreadPullRequestLinks"]]);
      assert.deepEqual(yield* runMigrations(), []);
      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
      `;
      const migrated = new Map(rows.map((row) => [row.thread_id, decodeThread(row.payload_json)]));
      assert.deepEqual(migrated.get("github")?.pullRequests, [
        { ...currentLink, number: 42, url: linked.url, source: "manual" },
      ]);
      assert.equal(migrated.get("forgejo")?.pullRequests?.[0]?.host, "forge.example:3000");
      assert.equal(migrated.get("azure")?.pullRequests?.[0]?.host, "dev.azure.com");
      assert.equal(migrated.get("azure")?.pullRequests?.[0]?.repository, "org/project/_git/web");
      assert.deepEqual(migrated.get("empty")?.pullRequests, []);
      assert.deepEqual(migrated.get("current")?.pullRequests, [currentLink]);
      assert.isUndefined(migrated.get("unlinked")?.pullRequests);
      assert.equal(migrated.get("page-500")?.pullRequests?.[0]?.number, 9000);
      assert.isTrue(
        [...migrated.values()].every((value) => DateTime.formatIso(value.updatedAt) === updatedAt),
      );
      const events = yield* sql<{ readonly stream_id: string; readonly payload_json: string }>`
        SELECT stream_id, payload_json FROM orchestration_events WHERE application_event_version = 2
      `;
      assert.deepEqual(
        new Map(events.map((event) => [event.stream_id, decodeThread(event.payload_json)])),
        migrated,
      );
      const [v1] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events WHERE event_id = 'event:v1'
      `;
      assert.equal(v1?.payload_json, v1Payload);

      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.isTrue((yield* maintenance.rebuild).valid);
      for (const [host, repository, id] of [
        ["github.com", "acme/web", "github"],
        ["forge.example:3000", "acme/web", "forgejo"],
        ["dev.azure.com", "org/project/_git/web", "azure"],
      ] as const) {
        assert.deepEqual(
          (yield* listLinkedPullRequestThreads({ host, repository, number: 42 })).threads.map(
            (value) => value.id,
          ),
          [ThreadId.make(id)],
        );
      }
    }),
  );
});
