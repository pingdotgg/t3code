import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
const CHRONOLOGICAL_POSITION_MIN = 100_000_000_000_000;

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    readonly sourceTimestamp?: DateTime.Utc;
    readonly chronological?: boolean;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
    chronological?: boolean,
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
          sourceTimestamp,
          chronological = false,
        }) {
          const existing = yield* sql<{ ordinal: number | null; chronological: number }>`
            SELECT (SELECT ordinal FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId} LIMIT 1) AS ordinal,
              EXISTS (SELECT 1 FROM orchestration_v2_turn_item_positions
                WHERE thread_id = ${threadId} AND ordinal >= ${CHRONOLOGICAL_POSITION_MIN}) AS chronological
          `;
          if (
            sourceTimestamp !== undefined &&
            (chronological || existing[0]?.chronological === 1)
          ) {
            // Reserve a millisecond bucket for source-ordered imports. Existing native
            // positions remain stable; legacy arrival-order imports are upgraded once.
            const base = 1_000_000 + DateTime.toEpochMillis(sourceTimestamp) * 1000;
            if (!Number.isSafeInteger(base) || base < 1_000_000)
              return yield* new TurnItemPositionStoreError({
                threadId,
                turnItemId,
                cause: "Invalid source timestamp",
              });
            if (existing[0]?.ordinal != null && existing[0].ordinal >= CHRONOLOGICAL_POSITION_MIN)
              return existing[0].ordinal;
            const rows = yield* sql<{ ordinal: number }>`
              SELECT COALESCE(MAX(ordinal), ${base - 1}) + 1 AS ordinal
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${threadId} AND ordinal >= ${base} AND ordinal < ${base + 1000}
            `;
            const ordinal = rows[0]!.ordinal;
            if (ordinal >= base + 1000)
              return yield* new TurnItemPositionStoreError({
                threadId,
                turnItemId,
                cause: "Source timestamp position bucket exhausted",
              });
            yield* sql`
              INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
              VALUES (${threadId}, ${turnItemId}, ${ordinal})
              ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
            `;
            return ordinal;
          }
          if (existing[0]?.ordinal != null) return existing[0].ordinal;

          const runRows =
            runId === null
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
      normalize: Effect.fnUntraced(function* (item, runOrdinal, chronological) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
          sourceTimestamp: item.startedAt ?? item.updatedAt,
          chronological: chronological ?? false,
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
