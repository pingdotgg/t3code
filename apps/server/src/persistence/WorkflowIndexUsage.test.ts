/**
 * Query-plan (index-use) verification tests.
 *
 * Runs EXPLAIN QUERY PLAN against the real migrated in-memory SQLite schema and
 * asserts that every hot-path workflow query uses an index rather than doing a
 * full table scan.
 *
 * SQLite EXPLAIN QUERY PLAN returns rows with columns: id, parent, notused, detail
 * "USING INDEX" or "USING COVERING INDEX" in `detail` → good (indexed lookup)
 * "SCAN <table>" without any "USING" clause        → bad  (full table scan)
 *
 * KNOWN LIMITATION (drift): the EXPLAINed statements below are hand-mirrored from
 * the production hot-path queries (each block cites its source). They are NOT
 * shared with the real query builders, so a production query that later changes
 * its WHERE/ORDER shape into a scanning form would NOT be caught here — this suite
 * would keep passing against the stale copy. Eliminating that fully would require
 * centralizing the production queries behind shared constructors (out of scope).
 * Treat this as "the intended indexes exist and serve the intended shapes," and
 * keep these statements in sync when you touch the cited source queries.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "./Migrations.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EqpRow {
  readonly id: number;
  readonly parent: number;
  readonly notused: number;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that the plan uses the SPECIFIC expected index by name (not merely
 * "some" index — SQLite could otherwise pick a different, less-suitable index
 * and still pass), and that no row is a bare full-table scan.
 *
 * SQLite renders an indexed lookup as e.g.
 *   "SEARCH workflow_outbound_delivery USING INDEX idx_..._due (delivery_state=?)"
 * so asserting the plan detail contains the expected index name both proves an
 * index is used AND pins which one.
 */
function assertIndexUsed(
  planRows: ReadonlyArray<EqpRow>,
  queryLabel: string,
  expectedIndex: string,
): void {
  const details = Array.from(planRows).map((r) => r.detail ?? "");

  // The expected index must appear by name in some plan row (this implies
  // USING INDEX, since the name only renders inside a "USING ... INDEX" clause).
  const usesExpectedIndex = details.some((d) => d.includes(expectedIndex));

  // No row may be a bare SCAN <table> that lacks any USING clause. (A join's
  // PK-side lookup renders as "SEARCH ... USING INTEGER PRIMARY KEY", not a bare
  // SCAN, so this only catches genuine full-table scans.)
  const bareScans = details.filter((d) => /^SCAN\s+\w+\s*$/i.test(d.trim()));

  assert.isTrue(
    usesExpectedIndex,
    `[${queryLabel}] Expected plan to use index "${expectedIndex}" but it did not.\nPlan rows:\n${details.join("\n")}`,
  );
  assert.deepStrictEqual(
    bareScans,
    [],
    `[${queryLabel}] Bare full-table scan detected — no index used.\nOffending rows:\n${bareScans.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer("WorkflowIndexUsage — hot-path queries must use indexes", (it) => {
  // -------------------------------------------------------------------------
  // 1. Outbound delivery dispatcher
  //    SELECT … FROM workflow_outbound_delivery
  //    WHERE delivery_state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  //    ORDER BY created_at ASC LIMIT 50
  //    → idx_workflow_outbound_delivery_due (delivery_state, next_attempt_at)
  // -------------------------------------------------------------------------
  it.effect("workflow_outbound_delivery sweep uses idx_workflow_outbound_delivery_due", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT delivery_id, board_id, ticket_id, connection_ref, formatter,
                 context_json, attempt_count
          FROM workflow_outbound_delivery
          WHERE delivery_state = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= '2026-06-15T00:00:00.000Z')
          ORDER BY created_at ASC
          LIMIT 50
        `;
      assertIndexUsed(plan, "outbound_delivery_sweep", "idx_workflow_outbound_delivery_due");
    }),
  );

  // -------------------------------------------------------------------------
  // 2. Notification outbox dispatcher
  //    SELECT … FROM workflow_notification_outbox
  //    WHERE delivery_state = 'pending'
  //    ORDER BY created_at ASC LIMIT 50
  //    → idx_workflow_notification_outbox_pending (delivery_state, created_at)
  // -------------------------------------------------------------------------
  it.effect(
    "workflow_notification_outbox sweep uses idx_workflow_notification_outbox_pending",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT outbox_id, ticket_id, board_id, sequence, status,
                 attention_kind, attention_reason, attempt_count
          FROM workflow_notification_outbox
          WHERE delivery_state = 'pending'
          ORDER BY created_at ASC
          LIMIT 50
        `;
        assertIndexUsed(
          plan,
          "notification_outbox_sweep",
          "idx_workflow_notification_outbox_pending",
        );
      }),
  );

  // -------------------------------------------------------------------------
  // 3. projection_ticket by board_id
  //    SELECT … FROM projection_ticket WHERE board_id = ?
  //    → idx_projection_ticket_board (board_id)
  // -------------------------------------------------------------------------
  it.effect("projection_ticket board lookup uses idx_projection_ticket_board", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT ticket_id, board_id, title, current_lane_key, status
          FROM projection_ticket
          WHERE board_id = 'board-1'
        `;
      assertIndexUsed(plan, "projection_ticket_by_board", "idx_projection_ticket_board");
    }),
  );

  // -------------------------------------------------------------------------
  // 4. workflow_events replay by ticket_id
  //    SELECT … FROM workflow_events WHERE ticket_id = ? ORDER BY stream_version ASC
  //    → idx_workflow_events_stream_version (ticket_id, stream_version)  [UNIQUE]
  // -------------------------------------------------------------------------
  it.effect("workflow_events replay uses idx_workflow_events_stream_version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT sequence, event_id, ticket_id, stream_version, event_type,
                 occurred_at, payload_json
          FROM workflow_events
          WHERE ticket_id = 'ticket-1'
          ORDER BY stream_version ASC
        `;
      assertIndexUsed(plan, "workflow_events_by_ticket", "idx_workflow_events_stream_version");
    }),
  );

  // -------------------------------------------------------------------------
  // 5. workflow_pr_state — open PRs poller
  //    SELECT … FROM workflow_pr_state AS pr INNER JOIN projection_ticket …
  //    WHERE pr.pr_state = 'open' AND ticket.terminal_at IS NULL
  //    → idx_workflow_pr_state_open (partial index WHERE pr_state = 'open')
  // -------------------------------------------------------------------------
  it.effect("workflow_pr_state open-prs query uses idx_workflow_pr_state_open", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT pr.ticket_id, pr.pr_number, pr.repo,
                 pr.last_head_sha, pr.last_ci_state, pr.last_review_decision,
                 pr.last_comment_cursor, ticket.board_id
          FROM workflow_pr_state AS pr
          INNER JOIN projection_ticket AS ticket
            ON ticket.ticket_id = pr.ticket_id
          WHERE pr.pr_state = 'open'
            AND ticket.terminal_at IS NULL
          ORDER BY pr.ticket_id ASC
        `;
      assertIndexUsed(plan, "pr_state_open_tickets", "idx_workflow_pr_state_open");
    }),
  );

  // -------------------------------------------------------------------------
  // 6. workflow_pr_observation — pending observations drain
  //    SELECT … FROM workflow_pr_observation WHERE status = 'pending'
  //    → idx_workflow_pr_observation_pending (status, ticket_id)
  // -------------------------------------------------------------------------
  it.effect("workflow_pr_observation pending drain uses idx_workflow_pr_observation_pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT obs.observation_id, obs.ticket_id, obs.event_name,
                 obs.payload_json, obs.message_body, obs.attempt_count
          FROM workflow_pr_observation AS obs
          INNER JOIN projection_ticket AS ticket
            ON ticket.ticket_id = obs.ticket_id
          WHERE obs.status = 'pending'
          ORDER BY obs.created_at ASC, obs.observation_id ASC
        `;
      assertIndexUsed(plan, "pr_observation_pending", "idx_workflow_pr_observation_pending");
    }),
  );

  // -------------------------------------------------------------------------
  // 7. projection_ticket terminal retention sweep
  //    SELECT … FROM projection_ticket
  //    WHERE board_id = ? AND current_lane_key = ? AND terminal_at IS NOT NULL
  //      AND terminal_at < ?
  //    ORDER BY terminal_at ASC
  //    → idx_projection_ticket_terminal_retention (board_id, current_lane_key, terminal_at)
  // -------------------------------------------------------------------------
  it.effect(
    "projection_ticket terminal retention sweep uses idx_projection_ticket_terminal_retention",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT ticket_id, terminal_at
          FROM projection_ticket
          WHERE board_id = 'board-1'
            AND current_lane_key = 'done'
            AND terminal_at IS NOT NULL
            AND terminal_at < '2026-06-01T00:00:00.000Z'
          ORDER BY terminal_at ASC, ticket_id ASC
        `;
        assertIndexUsed(
          plan,
          "projection_ticket_terminal_retention",
          "idx_projection_ticket_terminal_retention",
        );
      }),
  );

  // -------------------------------------------------------------------------
  // 8. workflow_dispatch_outbox — pending dispatch poll
  //    SELECT … FROM workflow_dispatch_outbox WHERE status = ?
  //    → idx_dispatch_outbox_pending (status)
  // -------------------------------------------------------------------------
  it.effect("workflow_dispatch_outbox pending poll uses idx_dispatch_outbox_pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<EqpRow>`
          EXPLAIN QUERY PLAN
          SELECT dispatch_id, ticket_id, step_run_id, thread_id,
                 provider_instance, model, instruction, worktree_path, status
          FROM workflow_dispatch_outbox
          WHERE status = 'pending'
        `;
      assertIndexUsed(plan, "dispatch_outbox_pending", "idx_dispatch_outbox_pending");
    }),
  );
});
