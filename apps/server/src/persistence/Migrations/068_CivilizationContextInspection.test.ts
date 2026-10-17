import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds bounded per-turn Civilization context inspection storage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(civilization_context_inspections)`;
    const names = columns.map((column) => column.name);
    assert.includeMembers(names, [
      "inspection_id",
      "run_id",
      "attempt_id",
      "provider_turn_ordinal",
      "outcome",
      "suppression_reason",
      "packet_text_state",
      "packet_hash",
      "packet_text",
      "packet_budget_bytes",
      "selected_note_ids_json",
      "provider_start_at",
    ]);

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, provider_driver, outcome, diagnostics_mode, packet_text_state,
        created_at, updated_at
      ) VALUES (
        'inspection:one', 'project:one', 'thread:one', 'run:one', 'attempt:one', 1,
        'codex', 'codex', 'built', 'normal', 'retained_normal',
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      )
    `;
    const duplicate = yield* Effect.exit(sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, provider_driver, outcome, diagnostics_mode, packet_text_state,
        created_at, updated_at
      ) VALUES (
        'inspection:two', 'project:one', 'thread:one', 'run:one', 'attempt:one', 1,
        'codex', 'codex', 'built', 'normal', 'retained_normal',
        '2026-10-16T00:00:01.000Z', '2026-10-16T00:00:01.000Z'
      )
    `);
    assert.isTrue(duplicate._tag === "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
