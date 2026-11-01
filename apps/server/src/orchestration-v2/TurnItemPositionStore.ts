import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    /** Moves a stored position that lies outside the item's run into that run. */
    readonly keepWithinRun?: boolean;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal: suppliedRunOrdinal,
          keepWithinRun = false,
        }) {
          const existing = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          const existingOrdinal = existing[0]?.ordinal;
          if (existingOrdinal !== undefined && (!keepWithinRun || runId === null)) {
            return existingOrdinal;
          }

          const runRows =
            runId === null || suppliedRunOrdinal !== undefined
              ? []
              : yield* sql<{ readonly ordinal: number }>`
                SELECT ordinal
                FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId}
                LIMIT 1
              `;
          const runOrdinal = suppliedRunOrdinal ?? runRows[0]?.ordinal ?? null;
          const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
          const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
          if (existingOrdinal !== undefined) {
            if (
              runOrdinal === null ||
              (existingOrdinal >= lowerBound && existingOrdinal <= upperBound)
            ) {
              return existingOrdinal;
            }
            yield* sql`
            DELETE FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          `;
          }
          yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `;
          const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          const ordinal = rows[0]?.ordinal;
          if (ordinal === undefined) {
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Position allocation returned no row.",
            });
          }
          return ordinal;
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
          // A user message keeps its id when it changes runs: a steer that
          // missed its turn starts the next run, and a queued message is
          // promoted into the running one. Its row follows the run it went to.
          keepWithinRun: item.type === "user_message",
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
