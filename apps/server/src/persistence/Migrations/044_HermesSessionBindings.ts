import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable Hermes identity and write-safety state.
 *
 * The live gateway session id is intentionally absent: Hermes only guarantees
 * the profile-scoped stored session key across reconnects. Mutation payloads
 * are represented by a caller-computed digest and are never stored here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE hermes_session_bindings (
      binding_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      stored_session_key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      protocol_classification TEXT NOT NULL
        CHECK (protocol_classification IN ('legacy', 'supported', 'unsupported')),
      protocol_major INTEGER,
      protocol_minor INTEGER,
      capabilities_json TEXT NOT NULL,
      reconciliation_cursor TEXT,
      reconciliation_fingerprint TEXT,
      lease_owner_key TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider_instance_id, profile_key, stored_session_key),
      CHECK (
        (protocol_major IS NULL AND protocol_minor IS NULL)
        OR (protocol_major IS NOT NULL AND protocol_minor IS NOT NULL)
      ),
      CHECK (
        (lease_owner_key IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner_key IS NOT NULL AND lease_expires_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE TABLE hermes_mutation_intents (
      operation_id TEXT PRIMARY KEY,
      binding_id TEXT REFERENCES hermes_session_bindings(binding_id) ON DELETE CASCADE,
      provider_instance_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      attempt_id TEXT,
      message_id TEXT,
      mutation_kind TEXT NOT NULL,
      method TEXT NOT NULL,
      payload_digest TEXT NOT NULL
        CHECK (
          length(payload_digest) = 64
          AND payload_digest NOT GLOB '*[^0-9a-f]*'
        ),
      owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
      state TEXT NOT NULL
        CHECK (
          state IN (
            'prepared',
            'admitted',
            'confirmed',
            'indeterminate',
            'reconciled',
            'rejected'
          )
        ),
      prepared_at TEXT NOT NULL,
      admitted_at TEXT,
      settled_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        binding_id IS NOT NULL
        OR (mutation_kind = 'session_create' AND owner_generation = 0)
      )
    )
  `;

  yield* sql`
    CREATE INDEX hermes_mutation_intents_binding_state_idx
    ON hermes_mutation_intents(binding_id, state, prepared_at, operation_id)
  `;

  yield* sql`
    CREATE INDEX hermes_mutation_intents_thread_state_idx
    ON hermes_mutation_intents(thread_id, state, prepared_at, operation_id)
  `;

  yield* sql`
    CREATE UNIQUE INDEX hermes_mutation_intents_one_unsettled_prompt_idx
    ON hermes_mutation_intents(binding_id)
    WHERE mutation_kind = 'prompt'
      AND state IN ('prepared', 'admitted', 'indeterminate')
  `;

  yield* sql`
    CREATE UNIQUE INDEX hermes_mutation_intents_one_unsettled_create_idx
    ON hermes_mutation_intents(provider_instance_id, profile_key, project_id, thread_id)
    WHERE mutation_kind = 'session_create'
      AND state IN ('prepared', 'admitted', 'indeterminate')
  `;

  /**
   * Durable, replayable bridge from Hermes profile sessions to T3 shells.
   * A row is written before the orchestration event. Deterministic thread and
   * command IDs plus the phase column make retry after any crash idempotent.
   *
   * `main` has no stored session identity until it is first opened; the normal
   * Hermes binding path then creates and attaches its durable Hermes session.
   */
  yield* sql`
    CREATE TABLE hermes_session_imports (
      import_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      import_kind TEXT NOT NULL CHECK (import_kind IN ('session', 'main')),
      stored_session_key TEXT,
      thread_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'thread_created', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (import_kind = 'session' AND stored_session_key IS NOT NULL)
        OR (import_kind = 'main' AND stored_session_key IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX hermes_session_imports_stored_identity_idx
    ON hermes_session_imports(provider_instance_id, profile_key, project_id, stored_session_key)
    WHERE import_kind = 'session'
  `;

  yield* sql`
    CREATE UNIQUE INDEX hermes_session_imports_one_main_idx
    ON hermes_session_imports(provider_instance_id, profile_key, project_id)
    WHERE import_kind = 'main'
  `;
});
