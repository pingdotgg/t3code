import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  PROJECTION_THREAD_CONTENT_SEARCH_LIMITS,
  ProjectionSnapshotQuery,
} from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `test:${workspaceRoot}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://example.test/search.git",
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
  }),
);

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(ProjectEnrichment.layer),
  Layer.provideMerge(metadataLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-content-search-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("searches bounded durable thread content without changing the legacy search RPC", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const projectId = ProjectId.make("project:search-current");
    const otherProjectId = ProjectId.make("project:search-other");
    const activeThreadId = ThreadId.make("thread:search-active");
    const archivedThreadId = ThreadId.make("thread:search-archived");
    const deletedThreadId = ThreadId.make("thread:search-deleted");
    const otherThreadId = ThreadId.make("thread:search-other");
    const legacyOnlyThreadId = ThreadId.make("thread:search-legacy-only");
    const longText = `${"prefix ".repeat(2_000)}literal %_! needle😀終 ${"suffix ".repeat(2_000)}`;
    const longTitle = `Needle active title ${"x".repeat(2_000)} hidden-title-match`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES
        (${projectId}, 'Current', '/tmp/search-current', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z', NULL),
        (${otherProjectId}, 'Other', '/tmp/search-other', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
        settled_override, settled_at, deleted_at
      ) VALUES
        (${activeThreadId}, ${projectId}, ${longTitle}, '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-10T00:00:00.000Z', NULL, NULL, NULL, NULL),
        (${archivedThreadId}, ${projectId}, 'Archived history', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z', '2026-01-09T00:00:00.000Z', NULL, NULL, NULL),
        (${deletedThreadId}, ${projectId}, 'Deleted needle', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-08T00:00:00.000Z', NULL, NULL, NULL, '2026-01-08T00:00:00.000Z'),
        (${otherThreadId}, ${otherProjectId}, 'Other needle', '{}', 'full-access', 'default',
          'main', '/tmp/search-other', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z', NULL, NULL, NULL, NULL),
        (${legacyOnlyThreadId}, ${projectId}, 'Legacy only history', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at,
        archived_at, deleted_at, payload_json
      ) VALUES
        (${activeThreadId}, ${projectId}, ${longTitle}, 'codex', 'codex',
          'full-access', 'default', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-10T00:00:00.000Z', NULL, NULL, '{}'),
        (${archivedThreadId}, ${projectId}, 'Archived history', 'codex', 'codex',
          'full-access', 'default', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z', '2026-01-09T00:00:00.000Z', NULL, '{}'),
        (${deletedThreadId}, ${projectId}, 'Deleted needle', 'codex', 'codex',
          'full-access', 'default', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-08T00:00:00.000Z', NULL, '2026-01-08T00:00:00.000Z', '{}'),
        (${otherThreadId}, ${otherProjectId}, 'Other needle', 'codex', 'codex',
          'full-access', 'default', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z', NULL, NULL, '{}')
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
        created_at, updated_at
      ) VALUES
        ('message:legacy-active', ${activeThreadId}, NULL, 'user', 'legacy needle', '[]', 0,
          '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('message:legacy-archived', ${archivedThreadId}, NULL, 'user', 'archived needle', '[]', 0,
          '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('message:legacy-other', ${otherThreadId}, NULL, 'user', 'secret needle', '[]', 0,
          '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z'),
        ('message:legacy-only', ${legacyOnlyThreadId}, NULL, 'user', 'legacy-only-marker', '[]', 0,
          '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES
        ('run:visible', ${activeThreadId}, 1, 'codex', NULL, 'completed',
          '2026-01-06T00:00:00.000Z', '2026-01-06T00:01:00.000Z', '{}'),
        ('run:rolled-back', ${activeThreadId}, 2, 'codex', NULL, 'rolled_back',
          '2026-01-07T00:00:00.000Z', '2026-01-07T00:01:00.000Z', '{}'),
        ('run:cancelled', ${activeThreadId}, 3, 'codex', NULL, 'cancelled',
          '2026-01-08T00:00:00.000Z', '2026-01-08T00:01:00.000Z', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES
        ('message:v2-visible', ${activeThreadId}, 'run:visible', NULL, 'assistant', 0,
          '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: longText })}),
        ('message:v2-user', ${activeThreadId}, 'run:visible', NULL, 'user', 0,
          '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: "visible user needle" })}),
        ('message:v2-streaming', ${activeThreadId}, 'run:visible', NULL, 'assistant', 1,
          '2026-01-05T00:00:01.000Z', '2026-01-05T00:00:01.000Z',
          ${encodeUnknownJsonString({ text: "streaming needle" })}),
        ('message:v2-rolled-back', ${activeThreadId}, 'run:rolled-back', NULL, 'assistant', 0,
          '2026-01-07T00:00:00.000Z', '2026-01-07T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: "rolled-back needle" })}),
        ('message:v2-cancelled', ${activeThreadId}, 'run:cancelled', NULL, 'user', 0,
          '2026-01-08T00:00:00.000Z', '2026-01-08T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: "cancelled needle" })})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES
        ('item:v2-visible', ${activeThreadId}, 'run:visible', NULL, NULL, NULL, NULL, 1,
          'assistant_message', 'completed', '2026-01-06T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-visible", text: longText, streaming: false })}),
        ('item:v2-user', ${activeThreadId}, 'run:visible', NULL, NULL, NULL, NULL, 2,
          'user_message', 'completed', '2026-01-05T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-user", text: "visible user needle", inputIntent: "direct" })}),
        ('item:v2-streaming', ${activeThreadId}, 'run:visible', NULL, NULL, NULL, NULL, 3,
          'assistant_message', 'streaming', '2026-01-05T00:00:01.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-streaming", text: "streaming needle", streaming: true })}),
        ('item:v2-rolled-back', ${activeThreadId}, 'run:rolled-back', NULL, NULL, NULL, NULL, 2,
          'assistant_message', 'completed', '2026-01-07T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-rolled-back", text: "rolled-back needle", streaming: false })}),
        ('item:v2-cancelled', ${activeThreadId}, 'run:cancelled', NULL, NULL, NULL, NULL, 3,
          'user_message', 'completed', '2026-01-08T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-cancelled", text: "cancelled needle", inputIntent: "queued_turn" })})
    `;

    const firstPage = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: true,
      offset: 0,
      limit: 2,
      snippetChars: 80,
    });
    assert.lengthOf(firstPage.hits, 2);
    assert.isTrue(firstPage.hasMore);
    assert.equal(firstPage.nextOffset, 2);
    assert.deepEqual(
      firstPage.hits.map((hit) => [hit.source, hit.origin]),
      [
        ["title", "v2"],
        ["assistant", "v2"],
      ],
    );
    const anchored = firstPage.hits[1];
    assert.equal(anchored?.sourceThreadId, activeThreadId);
    assert.equal(anchored?.messageId, "message:v2-visible");
    assert.equal(anchored?.itemId, "item:v2-visible");
    assert.match(anchored?.snippet ?? "", /needle/);
    assert.isAtMost(Array.from(anchored?.snippet ?? "").length, 80);
    assert.isTrue(anchored?.snippetTruncated ?? false);
    assert.isAtMost(
      Array.from(anchored?.threadTitle ?? "").length,
      PROJECTION_THREAD_CONTENT_SEARCH_LIMITS.titleMaxChars,
    );
    assert.isTrue(anchored?.threadTitleTruncated ?? false);

    const secondPage = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: true,
      offset: firstPage.nextOffset ?? 0,
      limit: 10,
      snippetChars: 80,
    });
    assert.deepEqual(
      secondPage.hits.map((hit) => hit.threadId),
      [activeThreadId, archivedThreadId, activeThreadId],
    );
    assert.equal(secondPage.hits[0]?.messageId, "message:v2-user");
    assert.equal(secondPage.hits[0]?.source, "user");
    assert.equal(secondPage.hits[0]?.origin, "v2");
    assert.isNull(secondPage.hits[1]?.sourceThreadId ?? null);
    assert.isTrue(secondPage.hits[1]?.archived ?? false);
    assert.notInclude(
      secondPage.hits.map((hit) => hit.messageId),
      MessageId.make("message:v2-streaming"),
    );
    assert.notInclude(
      secondPage.hits.map((hit) => hit.threadId),
      otherThreadId,
    );
    assert.notInclude(
      secondPage.hits.map((hit) => hit.threadId),
      deletedThreadId,
    );

    const activeOnly = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 80,
    });
    assert.isTrue(activeOnly.hits.every((hit) => !hit.archived));

    const legacyOnly = yield* query.searchThreadContent({
      projectId,
      query: "legacy-only-marker",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.equal(legacyOnly.hits[0]?.threadId, legacyOnlyThreadId);
    assert.equal(legacyOnly.hits[0]?.origin, "legacy");
    assert.isNull(legacyOnly.hits[0]?.sourceThreadId ?? null);

    const titleTail = yield* query.searchThreadContent({
      projectId,
      threadId: activeThreadId,
      query: "hidden-title-match",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.equal(titleTail.hits[0]?.source, "title");
    assert.isTrue(titleTail.hits[0]?.threadTitleTruncated ?? false);
    assert.isAtMost(
      Array.from(titleTail.hits[0]?.threadTitle ?? "").length,
      PROJECTION_THREAD_CONTENT_SEARCH_LIMITS.titleMaxChars,
    );
    assert.match(titleTail.hits[0]?.snippet ?? "", /hidden-title-match/);

    const literal = yield* query.searchThreadContent({
      projectId,
      threadId: activeThreadId,
      query: "%_!",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.deepEqual(
      literal.hits.map((hit) => hit.messageId),
      [MessageId.make("message:v2-visible")],
    );

    const nonAscii = yield* query.searchThreadContent({
      projectId,
      threadId: activeThreadId,
      query: "needle😀終",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.match(nonAscii.hits[0]?.snippet ?? "", /needle😀終/);
    assert.isAtMost(Array.from(nonAscii.hits[0]?.snippet ?? "").length, 64);

    const legacyResult = yield* query.searchThreads({ query: "needle", limit: 50 });
    assert.deepEqual(Object.keys(legacyResult), ["matches"]);
    assert.isTrue(legacyResult.matches.every((match) => match.source !== undefined));
    assert.isTrue(legacyResult.matches.every((match) => !("itemId" in match)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects out-of-bounds lower-layer requests before querying", () =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const failure = yield* Effect.flip(
      query.searchThreadContent({
        projectId: ProjectId.make("project:unused"),
        query: "needle",
        includeArchived: false,
        offset: PROJECTION_THREAD_CONTENT_SEARCH_LIMITS.offsetMax + 1,
        limit: 1,
        snippetChars: 64,
      }),
    );
    assert.equal(failure._tag, "ProjectionThreadContentSearchInputError");
    if (failure._tag !== "ProjectionThreadContentSearchInputError") {
      return yield* Effect.die("Expected bounded input failure.");
    }
    assert.equal(failure.field, "offset");
    assert.equal(failure.constraint.type, "range");

    const nulFailure = yield* Effect.flip(
      query.searchThreadContent({
        projectId: ProjectId.make("project:unused"),
        query: "unrelated\0needle",
        includeArchived: false,
        offset: 0,
        limit: 1,
        snippetChars: 64,
      }),
    );
    assert.equal(nulFailure._tag, "ProjectionThreadContentSearchInputError");
    if (nulFailure._tag !== "ProjectionThreadContentSearchInputError") {
      return yield* Effect.die("Expected NUL input failure.");
    }
    assert.equal(nulFailure.field, "query");
    assert.equal(nulFailure.constraint.type, "no_nul");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("search uses v2 visibility while legacy transcripts are still lazy", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const now = "2026-08-29T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        'project:search', 'Search', '/tmp/search', NULL,
        '[]', ${now}, ${now}, NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, branch, worktree_path, latest_turn_id, created_at,
        updated_at, archived_at, settled_override, settled_at, deleted_at
      ) VALUES
        ('thread:active', 'project:search', 'Active', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:archived', 'project:search', 'Archived', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:deleted', 'project:search', 'Deleted', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:assistant', 'project:search', 'Assistant', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, 'turn:assistant', ${now}, ${now}, NULL, NULL, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        ('message:active', 'thread:active', NULL, 'user', 'migration needle active', '[]', 0, ${now}, ${now}),
        ('message:archived', 'thread:archived', NULL, 'user', 'migration needle archived', '[]', 0, ${now}, ${now}),
        ('message:deleted', 'thread:deleted', NULL, 'user', 'migration needle deleted', '[]', 0, ${now}, ${now}),
        ('message:orphan-assistant', 'thread:assistant', NULL, 'assistant', 'migration needle orphan', '[]', 0, ${now}, ${now}),
        ('message:assistant', 'thread:assistant', 'turn:assistant', 'assistant', 'migration needle answer', '[]', 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_turns (
        turn_id, thread_id, state, requested_at, started_at, completed_at,
        assistant_message_id, checkpoint_files_json,
        source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (
        'turn:assistant', 'thread:assistant', 'completed', ${now}, ${now}, ${now},
        'message:assistant', '[]', NULL, NULL
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id, created_at,
        updated_at, archived_at, deleted_at, payload_json
      ) VALUES
        ('thread:active', 'project:search', 'Active', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, NULL, '{}'),
        ('thread:archived', 'project:search', 'Archived', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, ${now}, NULL, '{}'),
        ('thread:deleted', 'project:search', 'Deleted', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, ${now}, '{}')
    `;

    const result = yield* query.searchThreads({ query: "migration needle", limit: 20 });
    assert.deepEqual(
      result.matches.map((match) => [match.threadId, match.source, match.snippet]),
      [
        ["thread:active", "user", "migration needle active"],
        ["thread:assistant", "assistant", "migration needle answer"],
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);
