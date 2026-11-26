import type { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;

export class McpAppModelContextError extends Schema.TaggedError<McpAppModelContextError>()(
  "McpAppModelContextError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export interface McpAppModelContextEntry {
  readonly itemId: string;
  readonly server: string;
  readonly tool: string;
  readonly text: string;
  /** ISO time the app last set the note. */
  readonly updatedAt: string;
}

export class McpAppModelContext extends Context.Service<
  McpAppModelContext,
  {
    /** Empty text removes the app's context. */
    readonly set: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly server: string;
      readonly tool: string;
      readonly text: string;
    }) => Effect.Effect<void, McpAppModelContextError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<McpAppModelContextEntry>, McpAppModelContextError>;
  }
>()("t3/mcpApps/McpAppModelContext") {}

/** The thread's notes as a provider turn or steer sends them; a failed read sends none. */
export const forProvider = Effect.fn("McpAppModelContext.forProvider")(function* (
  modelContext: McpAppModelContext["Service"],
  threadId: ThreadId,
) {
  const entries = yield* modelContext
    .forThread(threadId)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read MCP app model context.", { cause }).pipe(
          Effect.as([] as ReadonlyArray<McpAppModelContextEntry>),
        ),
      ),
    );
  return entries.map((entry) => ({
    // The item id alone is unique and needs no escaping; server and
    // tool names are free text that would break the tag Codex wraps
    // the context in.
    key: `mcp_app_${entry.itemId.replace(/[^\w.-]/g, "_")}`,
    text: entry.text,
    updatedAt: entry.updatedAt,
  }));
});

export const layer = Layer.effect(
  McpAppModelContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) => new McpAppModelContextError({ cause });

    const set = Effect.fn("McpAppModelContext.set")(function* (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly server: string;
      readonly tool: string;
      readonly text: string;
    }) {
      if (input.text.trim() === "") {
        yield* sql`
          DELETE FROM mcp_app_model_context
          WHERE thread_id = ${input.threadId} AND item_id = ${input.itemId}
        `.pipe(Effect.mapError(fail));
        return;
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
        VALUES (${input.threadId}, ${input.itemId}, ${input.server}, ${input.tool}, ${input.text}, ${updatedAt})
        ON CONFLICT(thread_id, item_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `.pipe(Effect.mapError(fail));
    });

    const forThread = Effect.fn("McpAppModelContext.forThread")(function* (threadId: ThreadId) {
      // Match by id across fork lineage; later source rollbacks leave the fork's copy intact,
      // while a started non-scheduled /clear (freshContext) run on this thread clears older notes.
      return yield* sql<McpAppModelContextEntry>`
        WITH boundary AS (
          SELECT COALESCE(MAX(b.ordinal), 0) AS min_ordinal
          FROM orchestration_v2_projection_runs AS b
          WHERE b.thread_id = ${threadId}
            AND json_extract(b.payload_json, '$.freshContext') = 1
            AND b.status <> 'queued'
            AND NOT (
              b.status = 'cancelled'
              AND json_extract(b.payload_json, '$.startedAt') IS NULL
              AND json_extract(b.payload_json, '$.restartContinuationOfRunId') IS NULL
            )
            -- Mirrors isScheduledFreshRun: the run's first prompt, else its userMessageId's row.
            AND (
              SELECT json_extract(ti.payload_json, '$.scheduledTaskId')
              FROM orchestration_v2_projection_turn_items AS ti
              WHERE ti.thread_id = b.thread_id
                AND ti.type = 'user_message'
                AND (
                  ti.run_id = b.run_id
                  OR json_extract(ti.payload_json, '$.messageId') = json_extract(b.payload_json, '$.userMessageId')
                )
              ORDER BY ti.run_id = b.run_id DESC, ti.ordinal
              LIMIT 1
            ) IS NULL
        )
        SELECT context.item_id AS "itemId", context.server, context.tool, context.text,
          context.updated_at AS "updatedAt"
        FROM mcp_app_model_context AS context
        CROSS JOIN boundary
        JOIN orchestration_v2_projection_turn_items AS item
          ON item.turn_item_id = context.item_id
        LEFT JOIN orchestration_v2_projection_runs AS run
          ON run.run_id = item.run_id
        WHERE context.thread_id = ${threadId}
          AND (
            run.status IS NULL
            OR run.status <> 'rolled_back'
            OR run.thread_id <> context.thread_id
          )
          AND (
            boundary.min_ordinal = 0
            OR (run.thread_id = context.thread_id AND run.ordinal >= boundary.min_ordinal)
          )
        ORDER BY context.updated_at, context.item_id
      `.pipe(NodeSqliteClient.readOnly, Effect.mapError(fail));
    });

    return McpAppModelContext.of({ set, forThread });
  }),
);

export const layerEmpty = Layer.succeed(
  McpAppModelContext,
  McpAppModelContext.of({
    set: Effect.fn("McpAppModelContext.set")(function () {
      return Effect.void;
    }),
    forThread: Effect.fn("McpAppModelContext.forThread")(function () {
      return Effect.succeed([]);
    }),
  }),
);
