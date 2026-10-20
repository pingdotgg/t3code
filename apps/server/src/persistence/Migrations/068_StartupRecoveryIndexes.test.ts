import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades startup recovery lookups without changing candidate selection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* runMigrations({ toMigrationInclusive: 67 });

    for (const threadId of [
      "history",
      "active",
      "queued",
      "held",
      "malformed",
      "native",
      "child",
      "wrong-kind",
      "attached-root",
      "deleted",
      "archived",
      "duplicate",
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "project",
        title: threadId,
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-10-20",
        updated_at: "2026-10-20",
        deleted_at: threadId === "deleted" ? "2026-10-20" : null,
        archived_at: threadId === "archived" ? "2026-10-20" : null,
        payload_json: "{}",
      })}`;
    }
    for (const [threadId, status, payload] of [
      ["active", "running", '{"queueHeld":true}'],
      ["queued", "queued", "{}"],
      ["held", "queued", '{"queueHeld":true}'],
      ["malformed", "queued", "{"],
      ["deleted", "running", "{}"],
      ["archived", "waiting", "{}"],
      ["duplicate", "running", "{}"],
      ["duplicate", "queued", "{}"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: `${threadId}-${status}`,
        thread_id: threadId,
        ordinal: status === "queued" ? 2 : 1,
        provider: "codex",
        status,
        requested_at: "2026-10-20",
        payload_json: payload,
      })}`;
    }
    for (const [id, threadId, origin, status, childThreadId] of [
      ["native-live", "native", "provider_native", "waiting", null],
      ["app-live", "wrong-kind", "app_owned", "running", null],
      ["child-link", "history", "app_owned", "completed", "child"],
      ["wrong-kind-link", "history", "app_owned", "completed", "wrong-kind"],
      ["attached-link", "history", "app_owned", "completed", "attached-root"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
        subagent_id: id,
        thread_id: threadId,
        parent_node_id: "parent",
        provider: "codex",
        origin,
        status,
        child_thread_id: childThreadId,
        updated_at: "2026-10-20",
        payload_json: "{}",
      })}`;
    }
    for (const [threadId, kind, runId] of [
      ["child", "root_turn", null],
      ["wrong-kind", "tool_call", null],
      ["attached-root", "root_turn", "finished-run"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
        node_id: `${threadId}-node`,
        thread_id: threadId,
        run_id: runId,
        root_node_id: `${threadId}-node`,
        kind,
        status: "running",
        payload_json: "{}",
      })}`;
    }

    // Completed records dominate a real database. Their large payloads should
    // not need to be read just to find the few remaining recovery candidates.
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      SELECT 'historical-run-' || n, 'history', n, 'codex', 'completed', '2026-10-20',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, root_node_id, kind, status, payload_json)
      SELECT 'historical-node-' || n, 'child', 'child-node', 'tool_call', 'completed',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2048)
      INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      SELECT 'historical-subagent-' || n, 'history', 'parent', 'codex',
        'provider_native', 'completed', '2026-10-20',
        json_object('padding', printf('%.*c', 2048, 'x')) FROM history
    `;

    const expected = ["active", "archived", "child", "duplicate", "malformed", "native", "queued"];
    assert.deepStrictEqual((yield* store.getRecoveryThreadIds("runtime")).toSorted(), expected);
    assert.deepStrictEqual(yield* runMigrations(), [[68, "StartupRecoveryIndexes"]]);
    assert.deepStrictEqual(yield* runMigrations(), []);

    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    const candidates = yield* store.getRecoveryThreadIds("runtime").pipe(Effect.withTracer(tracer));
    assert.deepStrictEqual(candidates.toSorted(), expected);

    const statement = statements.find((query) => query.includes("pending_provider_threads"));
    assert.isDefined(statement);
    const plan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
    )).map(({ detail }) => detail);
    const details = plan.join("\n");
    assert.include(details, "orchestration_v2_projection_runs_recovery_idx");
    assert.include(details, "orchestration_v2_projection_nodes_unattached_recovery_idx");
    assert.include(details, "orchestration_v2_projection_subagents_live_native_idx");
    assert.isFalse(
      plan.some((detail) => detail === "SCAN orchestration_v2_projection_runs"),
      details,
    );
    assert.isFalse(
      plan.some((detail) => detail === "SCAN orchestration_v2_projection_subagents"),
      details,
    );
  }).pipe(
    Effect.provide(
      ProjectionStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
