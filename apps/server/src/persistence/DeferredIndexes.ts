import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Indexes over the large projection tables that reads can do without. Building one takes minutes
 * on a large database, so the server builds them after it starts serving. A read that pins one
 * with INDEXED BY must go through `pinDeferredIndex`, and each definition must stay spelled the
 * way the reads in ProjectionStore spell their filters.
 */
const deferredIndexes = [
  {
    migration: 82,
    name: "orchestration_v2_projection_turn_items_conversation_idx",
    definition: `
      ON orchestration_v2_projection_turn_items(thread_id, ordinal, type, run_id)
      WHERE type NOT IN (
        'command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool'
      )`,
  },
  {
    migration: 83,
    name: "orchestration_v2_projection_nodes_settled_leaf_idx",
    definition: `
      ON orchestration_v2_projection_nodes(
        thread_id,
        (kind IN ('tool_call', 'assistant_message', 'reasoning')
          AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
          AND run_id IS NOT NULL)
      )`,
  },
  {
    migration: 86,
    name: "orchestration_v2_projection_turn_items_queued_input_idx",
    definition: `
      ON orchestration_v2_projection_turn_items(run_id)
      WHERE type = 'user_message' AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'`,
  },
  {
    migration: 88,
    name: "orchestration_v2_projection_turn_items_thread_type_idx",
    definition: `ON orchestration_v2_projection_turn_items(thread_id, type, status)`,
  },
] as const;

export type DeferredIndexName = (typeof deferredIndexes)[number]["name"];

/** The deferred indexes this process has seen missing. The default is shared by the whole process. */
export const MissingDeferredIndexes = Context.Reference<Set<string>>(
  "t3/persistence/DeferredIndexes/MissingDeferredIndexes",
  { defaultValue: () => new Set() },
);

/** INDEXED BY for a deferred index, or nothing while it is not built: SQLite rejects a pin on a missing index. */
export const pinDeferredIndex = (missing: ReadonlySet<string>, name: DeferredIndexName) =>
  missing.has(name) ? "" : `INDEXED BY ${name}`;

const findMissingDeferredIndexes = Effect.fn("DeferredIndexes.findMissing")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return [];
  const [latest] = yield* sql<{
    readonly id: number | null;
  }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
  const built = new Set(
    (yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_schema WHERE type = 'index'`).map((row) => row.name),
  );
  return deferredIndexes.filter(
    (index) => index.migration <= (latest?.id ?? 0) && !built.has(index.name),
  );
});

export const noteMissingDeferredIndexes = Effect.fn("DeferredIndexes.noteMissing")(function* () {
  const missing = yield* MissingDeferredIndexes;
  for (const index of yield* findMissingDeferredIndexes()) missing.add(index.name);
});

/** Each index is its own statement, so other writes run between two builds and a restart keeps the finished ones. */
export const buildDeferredIndexes = Effect.fn("DeferredIndexes.build")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missing = yield* MissingDeferredIndexes;
  for (const index of yield* findMissingDeferredIndexes()) {
    yield* Effect.log("Building database index").pipe(Effect.annotateLogs({ index: index.name }));
    yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS ${index.name} ${index.definition}`);
    missing.delete(index.name);
  }
});
