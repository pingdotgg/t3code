import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("synchronizes successful inspection provenance into bounded context references", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 70 });

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id, provider_driver, outcome,
        diagnostics_mode, packet_text_state, packet_revision, packet_hash, packet_bytes,
        selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json,
        environment_revision, project_revision, citizen_revision, census_revision,
        notes_revision, inbox_revision, created_at, updated_at
      ) VALUES (
        'inspection:sync', 'reference:sync', 'project:sync', 'thread:sync', 'run:sync', 'attempt:sync',
        1, 'codex-main', 'codex', 'built',
        'normal', 'retained_normal', 'revision:one', 'sha256:one', 123,
        '["thread:a"]', '["note:a"]', '["message:a"]',
        2, 3, 4, 5, 6, 7,
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      )
    `;

    const inserted = (yield* sql<{
      readonly context_reference_id: string;
      readonly provider_instance_id: string;
      readonly packet_hash: string;
      readonly packet_bytes: number;
      readonly inbox_revision: number;
      readonly selected_note_ids_json: string;
    }>`
      SELECT context_reference_id, provider_instance_id, packet_hash, packet_bytes,
             inbox_revision, selected_note_ids_json
      FROM civilization_context_references
      WHERE context_reference_id = 'reference:sync'
    `)[0]!;
    assert.deepStrictEqual(inserted, {
      context_reference_id: "reference:sync",
      provider_instance_id: "codex-main",
      packet_hash: "sha256:one",
      packet_bytes: 123,
      inbox_revision: 7,
      selected_note_ids_json: '["note:a"]',
    });

    yield* sql`
      UPDATE civilization_context_inspections
      SET provider_instance_id = 'claude-main',
          packet_hash = 'sha256:two',
          packet_bytes = 456,
          selected_note_ids_json = '["note:b"]',
          inbox_revision = 8,
          updated_at = '2026-10-16T00:00:01.000Z'
      WHERE inspection_id = 'inspection:sync'
    `;
    const updated = (yield* sql<{
      readonly provider_instance_id: string;
      readonly packet_hash: string;
      readonly packet_bytes: number;
      readonly inbox_revision: number;
      readonly selected_note_ids_json: string;
    }>`
      SELECT provider_instance_id, packet_hash, packet_bytes, inbox_revision, selected_note_ids_json
      FROM civilization_context_references
      WHERE context_reference_id = 'reference:sync'
    `)[0]!;
    assert.deepStrictEqual(updated, {
      provider_instance_id: "claude-main",
      packet_hash: "sha256:two",
      packet_bytes: 456,
      inbox_revision: 8,
      selected_note_ids_json: '["note:b"]',
    });

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id, provider_driver, outcome,
        diagnostics_mode, packet_text_state, created_at, updated_at
      ) VALUES (
        'inspection:skipped', NULL, 'project:sync', 'thread:sync', 'run:skip', 'attempt:skip',
        1, 'codex-main', 'codex', 'skipped',
        'normal', 'skipped_no_packet',
        '2026-10-16T00:00:02.000Z', '2026-10-16T00:00:02.000Z'
      )
    `;
    assert.equal(
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_context_references
      `)[0]!.count,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
