import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// The sql template binds `undefined` as NULL; `sql.unsafe` passes values through unchanged.
type ProjectionValue = string | number | null | undefined;

export interface ProjectionTable<Column extends string> {
  readonly name: string;
  readonly key: Column;
  readonly columns: ReadonlyArray<Column>;
  /** Columns an index reads; an update that changes one takes the full upsert. */
  readonly guarded: ReadonlyArray<Column>;
  /** Conflict assignments other than `excluded.<column>`; they may read the stored row. */
  readonly onConflict: Partial<Record<Column, string>>;
  readonly guardedUpsert: string;
  readonly fullUpsert: string;
}

// SQLite rewrites the entry of every index on a column an UPDATE assigns, even to the value it holds
// (aXRef in sqlite3Update, src/update.c), so the guarded upsert leaves the guarded columns out
// while they hold their new values already. When one changes, it writes nothing and the full upsert runs.
const projectionTable = <const Column extends string>(spec: {
  readonly name: string;
  readonly key: Column;
  readonly columns: ReadonlyArray<Column>;
  readonly guarded: ReadonlyArray<Column>;
  readonly onConflict?: Partial<Record<Column, string>>;
}): ProjectionTable<Column> => {
  const onConflict: Partial<Record<Column, string>> = spec.onConflict ?? {};
  const conflictValue = (column: Column) => onConflict[column] ?? `excluded.${column}`;
  const assign = (columns: ReadonlyArray<Column>) =>
    columns.map((column) => `${column} = ${conflictValue(column)}`).join(",\n  ");
  const updated = spec.columns.filter((column) => column !== spec.key);
  const insert = `INSERT INTO ${spec.name} (${spec.columns.join(", ")})
VALUES (${spec.columns.map(() => "?").join(", ")})
ON CONFLICT(${spec.key}) DO UPDATE SET
  `;
  return {
    ...spec,
    onConflict,
    guardedUpsert: `${insert}${assign(updated.filter((column) => !spec.guarded.includes(column)))}
WHERE ${spec.guarded.map((column) => `${spec.name}.${column} IS ${conflictValue(column)}`).join("\n  AND ")}
RETURNING 1`,
    fullUpsert: `${insert}${assign(updated)}`,
  };
};

export const upsertProjectionRow = <Column extends string>(
  sql: SqlClient.SqlClient,
  table: ProjectionTable<Column>,
  row: Readonly<Record<Column, ProjectionValue>>,
) => {
  const values = table.columns.map((column) => row[column] ?? null);
  return sql
    .unsafe(table.guardedUpsert, values)
    .pipe(
      Effect.flatMap((written) =>
        written.length > 0 ? Effect.void : Effect.asVoid(sql.unsafe(table.fullUpsert, values)),
      ),
    );
};

// Only tables whose streamed updates mostly keep their indexed values; elsewhere the guard would
// fail on most updates and add a statement.
export const projectionTables = {
  subagents: projectionTable({
    name: "orchestration_v2_projection_subagents",
    key: "subagent_id",
    columns: [
      "subagent_id",
      "thread_id",
      "run_id",
      "parent_node_id",
      "provider",
      "driver",
      "provider_instance_id",
      "provider_thread_id",
      "child_thread_id",
      "origin",
      "status",
      "started_at",
      "completed_at",
      "updated_at",
      "completion_delivery_state",
      "payload_json",
    ],
    guarded: [
      "thread_id",
      "run_id",
      "parent_node_id",
      "provider_thread_id",
      "child_thread_id",
      "status",
      "started_at",
      "completion_delivery_state",
    ],
    onConflict: {
      completion_delivery_state: `COALESCE(
    excluded.completion_delivery_state,
    orchestration_v2_projection_subagents.completion_delivery_state
  )`,
      payload_json: `CASE
    WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
      AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
    THEN json_set(
      excluded.payload_json,
      '$.completionDelivery',
      json_extract(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery')
    )
    ELSE excluded.payload_json
  END`,
    },
  }),
  providerThreads: projectionTable({
    name: "orchestration_v2_projection_provider_threads",
    key: "provider_thread_id",
    columns: [
      "provider_thread_id",
      "thread_id",
      "owner_node_id",
      "provider",
      "driver",
      "provider_instance_id",
      "provider_session_id",
      "status",
      "first_run_ordinal",
      "last_run_ordinal",
      "updated_at",
      "payload_json",
    ],
    guarded: [
      "thread_id",
      "owner_node_id",
      "provider_instance_id",
      "provider_session_id",
      "status",
    ],
  }),
  providerTurns: projectionTable({
    name: "orchestration_v2_projection_provider_turns",
    key: "provider_turn_id",
    columns: [
      "provider_turn_id",
      "thread_id",
      "provider_thread_id",
      "node_id",
      "run_attempt_id",
      "ordinal",
      "status",
      "started_at",
      "completed_at",
      "payload_json",
    ],
    guarded: ["thread_id", "provider_thread_id", "ordinal"],
  }),
  turnItems: projectionTable({
    name: "orchestration_v2_projection_turn_items",
    key: "turn_item_id",
    columns: [
      "turn_item_id",
      "thread_id",
      "run_id",
      "node_id",
      "provider_thread_id",
      "provider_turn_id",
      "parent_item_id",
      "ordinal",
      "type",
      "status",
      "updated_at",
      "payload_json",
    ],
    guarded: ["thread_id", "run_id", "node_id", "provider_turn_id", "ordinal", "type", "status"],
  }),
};
