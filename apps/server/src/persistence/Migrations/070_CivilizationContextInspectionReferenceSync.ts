import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A successful provider-turn packet has two durable provenance views:
  // the legacy bounded context reference and the richer historical inspection.
  // The inspection is a strict superset of the reference fields, so synchronize
  // the reference inside the same SQLite statement instead of paying a second
  // application round-trip/autocommit on every provider turn.
  yield* sql`
    CREATE TRIGGER civilization_context_inspection_reference_insert
    AFTER INSERT ON civilization_context_inspections
    WHEN NEW.context_reference_id IS NOT NULL
      AND NEW.packet_hash IS NOT NULL
      AND NEW.environment_revision IS NOT NULL
      AND NEW.project_revision IS NOT NULL
      AND NEW.citizen_revision IS NOT NULL
      AND NEW.census_revision IS NOT NULL
      AND NEW.notes_revision IS NOT NULL
      AND NEW.inbox_revision IS NOT NULL
    BEGIN
      INSERT INTO civilization_context_references (
        context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id,
        environment_revision, project_revision, citizen_revision,
        census_revision, notes_revision, inbox_revision, packet_hash, packet_bytes,
        selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json,
        created_at
      ) VALUES (
        NEW.context_reference_id, NEW.project_id, NEW.thread_id, NEW.run_id, NEW.attempt_id,
        NEW.provider_turn_ordinal, NEW.provider_instance_id,
        NEW.environment_revision, NEW.project_revision, NEW.citizen_revision,
        NEW.census_revision, NEW.notes_revision, NEW.inbox_revision, NEW.packet_hash, NEW.packet_bytes,
        NEW.selected_citizen_ids_json, NEW.selected_note_ids_json, NEW.selected_inbox_ids_json,
        NEW.created_at
      )
      ON CONFLICT(context_reference_id) DO UPDATE SET
        provider_instance_id = excluded.provider_instance_id,
        environment_revision = excluded.environment_revision,
        project_revision = excluded.project_revision,
        citizen_revision = excluded.citizen_revision,
        census_revision = excluded.census_revision,
        notes_revision = excluded.notes_revision,
        inbox_revision = excluded.inbox_revision,
        packet_hash = excluded.packet_hash,
        packet_bytes = excluded.packet_bytes,
        selected_citizen_ids_json = excluded.selected_citizen_ids_json,
        selected_note_ids_json = excluded.selected_note_ids_json,
        selected_inbox_ids_json = excluded.selected_inbox_ids_json,
        created_at = excluded.created_at;
    END
  `;

  // `persistInspection` is an UPSERT keyed by provider-turn identity. SQLite
  // executes its UPDATE arm without firing the INSERT trigger, so keep the
  // reference synchronized for a repeated/idempotent build of the same turn.
  yield* sql`
    CREATE TRIGGER civilization_context_inspection_reference_update
    AFTER UPDATE OF
      context_reference_id,
      provider_instance_id,
      environment_revision,
      project_revision,
      citizen_revision,
      census_revision,
      notes_revision,
      inbox_revision,
      packet_hash,
      packet_bytes,
      selected_citizen_ids_json,
      selected_note_ids_json,
      selected_inbox_ids_json,
      created_at
    ON civilization_context_inspections
    WHEN NEW.context_reference_id IS NOT NULL
      AND NEW.packet_hash IS NOT NULL
      AND NEW.environment_revision IS NOT NULL
      AND NEW.project_revision IS NOT NULL
      AND NEW.citizen_revision IS NOT NULL
      AND NEW.census_revision IS NOT NULL
      AND NEW.notes_revision IS NOT NULL
      AND NEW.inbox_revision IS NOT NULL
    BEGIN
      INSERT INTO civilization_context_references (
        context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id,
        environment_revision, project_revision, citizen_revision,
        census_revision, notes_revision, inbox_revision, packet_hash, packet_bytes,
        selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json,
        created_at
      ) VALUES (
        NEW.context_reference_id, NEW.project_id, NEW.thread_id, NEW.run_id, NEW.attempt_id,
        NEW.provider_turn_ordinal, NEW.provider_instance_id,
        NEW.environment_revision, NEW.project_revision, NEW.citizen_revision,
        NEW.census_revision, NEW.notes_revision, NEW.inbox_revision, NEW.packet_hash, NEW.packet_bytes,
        NEW.selected_citizen_ids_json, NEW.selected_note_ids_json, NEW.selected_inbox_ids_json,
        NEW.created_at
      )
      ON CONFLICT(context_reference_id) DO UPDATE SET
        provider_instance_id = excluded.provider_instance_id,
        environment_revision = excluded.environment_revision,
        project_revision = excluded.project_revision,
        citizen_revision = excluded.citizen_revision,
        census_revision = excluded.census_revision,
        notes_revision = excluded.notes_revision,
        inbox_revision = excluded.inbox_revision,
        packet_hash = excluded.packet_hash,
        packet_bytes = excluded.packet_bytes,
        selected_citizen_ids_json = excluded.selected_citizen_ids_json,
        selected_note_ids_json = excluded.selected_note_ids_json,
        selected_inbox_ids_json = excluded.selected_inbox_ids_json,
        created_at = excluded.created_at;
    END
  `;
});
