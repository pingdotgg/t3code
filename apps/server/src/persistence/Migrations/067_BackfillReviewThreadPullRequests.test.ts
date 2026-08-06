import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "067_BackfillReviewThreadPullRequests",
  (it) => {
    it.effect("backfills only threads with explicit pull-request review snapshots", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 66 });

        const insertThread = (input: {
          readonly id: string;
          readonly branch: string;
          readonly reviewSnapshot: unknown;
        }) =>
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
              ${input.id},
              'project-1',
              ${input.id},
              '{"model":"gpt","instanceId":"codex"}',
              'full-access',
              'default',
              ${input.branch},
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
              'null',
              ${JSON.stringify(input.reviewSnapshot)}
            )
          `;

        yield* insertThread({
          id: "review-pr",
          branch: "unrelated-live-branch",
          reviewSnapshot: {
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
          },
        });
        yield* insertThread({
          id: "branch-only",
          branch: "feature/pr-146",
          reviewSnapshot: {
            scope: { kind: "uncommitted", branch: "feature/pr-146", untrackedFiles: [] },
            diff: "diff",
            diffHash: "hash-2",
          },
        });

        yield* runMigrations({ toMigrationInclusive: 67 });

        const rows = yield* sql<{ readonly id: string; readonly pr: string }>`
          SELECT thread_id AS id, pull_request_json AS pr
          FROM projection_threads
          ORDER BY thread_id
        `;
        assert.deepStrictEqual(rows, [
          { id: "branch-only", pr: "null" },
          {
            id: "review-pr",
            pr: JSON.stringify({
              number: 146,
              title: "Explicit review",
              url: "https://github.com/acme/repo/pull/146",
              baseBranch: "main",
              headBranch: "feature/pr-146",
              state: null,
            }),
          },
        ]);
      }),
    );
  },
);
