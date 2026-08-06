import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const reviewSnapshot = {
  scope: {
    kind: "pull-request",
    number: 146,
    title: "Explicit review",
    url: "https://github.com/acme/repo/pull/146",
    baseBranch: "main",
    headBranch: "feature/pr-146",
  },
  diff: "diff",
  diffHash: "hash",
};
const pullRequest = {
  number: reviewSnapshot.scope.number,
  title: reviewSnapshot.scope.title,
  url: reviewSnapshot.scope.url,
  baseBranch: reviewSnapshot.scope.baseBranch,
  headBranch: reviewSnapshot.scope.headBranch,
  state: "open",
};

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "068_RepairReviewThreadPullRequestState",
  (it) => {
    it.effect("repairs fabricated legacy state without clearing explicit known state", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });

        const insertThread = (id: string) =>
          sql`
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
              latest_user_message_at,
              pending_approval_count,
              pending_user_input_count,
              has_actionable_proposed_plan,
              deleted_at,
              pull_request_json,
              review_snapshot_json
            ) VALUES (
              ${id},
              'project-1',
              ${id},
              '{"model":"gpt","instanceId":"codex"}',
              'full-access',
              'default',
              'feature/pr-146',
              NULL,
              NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL,
              NULL,
              0,
              0,
              0,
              NULL,
              ${JSON.stringify(pullRequest)},
              ${JSON.stringify(reviewSnapshot)}
            )
          `;

        yield* insertThread("legacy-review");
        yield* insertThread("explicit-review");

        const insertCreatedEvent = (id: string, pullRequest: unknown) =>
          sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            ) VALUES (
              ${`event-${id}`},
              'thread',
              ${id},
              1,
              'thread.created',
              '2026-01-01T00:00:00.000Z',
              ${`command-${id}`},
              NULL,
              ${`command-${id}`},
              'user',
              ${JSON.stringify({
                threadId: id,
                reviewSnapshot,
                ...(pullRequest !== undefined ? { pullRequest } : {}),
              })},
              '{}'
            )
          `;

        yield* insertCreatedEvent("legacy-review", undefined);
        yield* insertCreatedEvent("explicit-review", pullRequest);

        yield* runMigrations({ toMigrationInclusive: 68 });

        const rows = yield* sql<{ readonly id: string; readonly pr: string }>`
          SELECT thread_id AS id, pull_request_json AS pr
          FROM projection_threads
          ORDER BY thread_id
        `;
        assert.deepStrictEqual(
          rows.map((row) => ({ id: row.id, state: JSON.parse(row.pr).state })),
          [
            { id: "explicit-review", state: "open" },
            { id: "legacy-review", state: null },
          ],
        );
      }),
    );
  },
);
