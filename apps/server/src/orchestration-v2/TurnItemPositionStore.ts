import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedErrorClass<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
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

    const allocate: TurnItemPositionStoreV2Shape["allocate"] = ({
      threadId,
      turnItemId,
      runId,
      runOrdinal: suppliedRunOrdinal,
    }) =>
      Effect.gen(function* () {
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
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(TurnItemPositionStoreError)(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      normalize: (item, runOrdinal) =>
        allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal }))),
    });
  }),
);
