import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Per-turn Civilization inspection is diagnostic provenance, not provider history.
  // Exact packet text is retained only according to operations.diagnostics; metadata
  // remains bounded and independently useful when sensitive text retention is disabled.
  yield* sql`
    CREATE TABLE civilization_context_inspections (
      inspection_id TEXT PRIMARY KEY,
      context_reference_id TEXT,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_turn_ordinal INTEGER NOT NULL CHECK (provider_turn_ordinal >= 0),
      provider_instance_id TEXT NOT NULL,
      provider_driver TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN (
        'skipped', 'built', 'provider_start_accepted', 'provider_start_failed'
      )),
      suppression_reason TEXT CHECK (suppression_reason IS NULL OR suppression_reason IN (
        'participation_disabled', 'emergency_off', 'citizen_not_adopted',
        'citizen_deleted', 'citizen_closed', 'observed_agent_read_only',
        'provider_unsupported',
        'claude_provider_continuation', 'claude_slash_command',
        'packet_budget_zero', 'packet_budget_too_small'
      )),
      diagnostics_mode TEXT NOT NULL CHECK (diagnostics_mode IN ('off', 'errors', 'normal')),
      packet_text_state TEXT NOT NULL CHECK (packet_text_state IN (
        'pending_provider_start', 'retained_normal', 'retained_error', 'diagnostics_off',
        'errors_only_accepted_cleared', 'skipped_no_packet'
      )),
      transport_kind TEXT,
      transport_description TEXT,
      transport_trust TEXT CHECK (transport_trust IS NULL OR transport_trust = 'untrusted'),
      packet_revision TEXT,
      packet_hash TEXT,
      packet_bytes INTEGER NOT NULL DEFAULT 0 CHECK (packet_bytes >= 0 AND packet_bytes <= 16384),
      packet_text TEXT,
      packet_budget_bytes INTEGER NOT NULL DEFAULT 0 CHECK (packet_budget_bytes >= 0 AND packet_budget_bytes <= 16384),
      required_bytes INTEGER NOT NULL DEFAULT 0 CHECK (required_bytes >= 0),
      roster_bytes INTEGER NOT NULL DEFAULT 0 CHECK (roster_bytes >= 0),
      note_bytes INTEGER NOT NULL DEFAULT 0 CHECK (note_bytes >= 0),
      inbox_bytes INTEGER NOT NULL DEFAULT 0 CHECK (inbox_bytes >= 0),
      unused_bytes INTEGER NOT NULL DEFAULT 0 CHECK (unused_bytes >= 0),
      roster_candidates INTEGER NOT NULL DEFAULT 0 CHECK (roster_candidates >= 0),
      roster_included INTEGER NOT NULL DEFAULT 0 CHECK (roster_included >= 0),
      note_candidates INTEGER NOT NULL DEFAULT 0 CHECK (note_candidates >= 0),
      note_included INTEGER NOT NULL DEFAULT 0 CHECK (note_included >= 0),
      inbox_candidates INTEGER NOT NULL DEFAULT 0 CHECK (inbox_candidates >= 0),
      inbox_included INTEGER NOT NULL DEFAULT 0 CHECK (inbox_included >= 0),
      selected_citizen_ids_json TEXT NOT NULL DEFAULT '[]',
      selected_note_ids_json TEXT NOT NULL DEFAULT '[]',
      selected_inbox_ids_json TEXT NOT NULL DEFAULT '[]',
      environment_revision INTEGER,
      project_revision INTEGER,
      citizen_revision INTEGER,
      census_revision INTEGER,
      notes_revision INTEGER,
      inbox_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider_start_at TEXT,
      UNIQUE (run_id, attempt_id, provider_turn_ordinal)
    )
  `;
  yield* sql`
    CREATE INDEX civilization_context_inspections_project_recent_idx
    ON civilization_context_inspections(project_id, created_at DESC, inspection_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_context_inspections_thread_recent_idx
    ON civilization_context_inspections(project_id, thread_id, created_at DESC, inspection_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_context_inspections_run_idx
    ON civilization_context_inspections(project_id, run_id, attempt_id, provider_turn_ordinal)
  `;
});
