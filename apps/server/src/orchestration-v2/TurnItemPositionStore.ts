import {
  OrchestrationV2TurnItem,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
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
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly reserveBoundary: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId;
    readonly runOrdinal?: number;
    readonly queuedRunId: RunId;
    readonly offerId: string;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<void, TurnItemPositionStoreError>;
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

    const allocate =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal: suppliedRunOrdinal,
          moveToRun = false,
        }: Parameters<TurnItemPositionStoreV2Shape["allocate"]>[0] & {
          readonly moveToRun?: boolean | "always";
        }) {
          const existing = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          if (existing[0] !== undefined && moveToRun === false) return existing[0].ordinal;

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
          if (existing[0] !== undefined) {
            if (
              moveToRun !== "always" &&
              existing[0].ordinal >= lowerBound &&
              existing[0].ordinal <= upperBound
            ) {
              return existing[0].ordinal;
            }
            yield* sql`
          UPDATE orchestration_v2_turn_item_positions
          SET ordinal = (
            SELECT COALESCE(MAX(ordinal), ${lowerBound}) + 1
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId}
              AND ordinal >= ${lowerBound}
              AND ordinal <= ${upperBound}
          )
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
            AND (${moveToRun === "always" ? 1 : 0} = 1 OR ordinal < ${lowerBound} OR ordinal > ${upperBound})
        `;
          } else {
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
          }
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
      reserveBoundary: Effect.fn("TurnItemPositionStore.reserveBoundary")(
        function* (input) {
          const offered = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${input.threadId} AND run_id = ${input.queuedRunId}
              AND status = 'queued'
              AND json_extract(payload_json, '$.boundaryOffer.id') = ${input.offerId}
              AND json_extract(payload_json, '$.boundaryOffer.targetRunId') = ${input.runId}
              AND json_extract(payload_json, '$.boundaryOffer.providerTurnId') = ${input.providerTurnId}
          `;
          if (offered.length === 0) return;
          const tokenId = TurnItemId.make(`turn-item:boundary-offer:${input.offerId}`);
          const reserved = yield* sql<{ readonly ordinal: number }>`
            SELECT ordinal FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${input.threadId} AND turn_item_id = ${tokenId}
          `;
          if (reserved.length > 0) return;
          // The invisible token distinguishes a retry in the same run from a duplicate receipt.
          yield* allocate({ ...input, turnItemId: tokenId });
          yield* allocate({ ...input, moveToRun: "always" });
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            sql.withTransaction,
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      ),
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
          // Explicit retry replaces the old boundary reservation with the committed run's position.
          moveToRun: item.type === "user_message" && item.status !== "pending",
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
