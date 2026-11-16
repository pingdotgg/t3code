import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  type MessageId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import {
  FYI_WAITING_SQL,
  isFyiItem,
  renderForToolBatch,
  renderForTurn,
  turnCarriesFyi,
  type FyiItem,
} from "./Fyi.ts";

/** The run attempt that takes an FYI: the run and its current root node, and the provider thread. */
export interface FyiCarrier {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
}

export interface TurnFyi {
  /** The FYI block for the prompt's inline context; empty when the turn carries none. */
  readonly text: string;
  /**
   * Binds the rendered entries to the carrier. Run it right before the provider gets the prompt,
   * so no tool call of the same attempt takes them again. It never fails; an entry it could not
   * bind stays waiting and may arrive twice.
   */
  readonly carry: (carrier: FyiCarrier) => Effect.Effect<void>;
}

const NO_FYI: TurnFyi = { text: "", carry: () => Effect.void };

const CARRY_CONCURRENCY = 8;

export interface FyiDeliveryShape {
  readonly forTurn: (
    input: Parameters<typeof turnCarriesFyi>[0] & { readonly threadId: ThreadId },
  ) => Effect.Effect<TurnFyi>;
  /**
   * The waiting FYI messages for a running turn's next model request, already bound to `carrier`.
   * Only entries this call bound are in the text; `undefined` when there are none. It starts no
   * bind once `stop` returns true, and it never fails.
   */
  readonly forToolBatch: (input: {
    readonly threadId: ThreadId;
    readonly carrier: FyiCarrier;
    readonly stop: () => boolean;
  }) => Effect.Effect<string | undefined>;
  /**
   * The events that make the FYI messages these runs carried runless again, for a rollback to
   * write with the runs: timelines hide a rolled-back run's items. Each then waits where it was
   * sent. It never fails; on an error the messages stay hidden, still waiting.
   */
  readonly unbind: (input: {
    readonly threadId: ThreadId;
    readonly runIds: ReadonlyArray<RunId>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>>;
}

export class FyiDelivery extends Context.Service<FyiDelivery, FyiDeliveryShape>()(
  "t3/fork/fyi/FyiDelivery",
) {}

const none = FyiDelivery.of({
  forTurn: Effect.fn("FyiDelivery.forTurnNone")(() => Effect.succeed(NO_FYI)),
  forToolBatch: Effect.fn("FyiDelivery.forToolBatchNone")(() => Effect.undefined),
  unbind: Effect.fn("FyiDelivery.unbindNone")(() => Effect.succeed([])),
});

/** The provided service. A runtime without one, such as a test of the calling service, sends no FYI. */
export const orNone = Effect.serviceOption(FyiDelivery).pipe(
  Effect.map(Option.getOrElse(() => none)),
);

/** The provided service, or `undefined` in a runtime without one, such as an adapter test. */
export const provided = Effect.serviceOption(FyiDelivery).pipe(Effect.map(Option.getOrUndefined));

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);

export const layer: Layer.Layer<FyiDelivery, never, SqlClient.SqlClient | EventSink.EventSinkV2> =
  Layer.effect(
    FyiDelivery,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;

      const readWaiting = Effect.fn("FyiDelivery.readWaiting")(function* (threadId: ThreadId) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT item.payload_json
          FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.thread_id = ${threadId} AND ${sql.literal(FYI_WAITING_SQL)}
          ORDER BY item.ordinal`;
        return (yield* Effect.forEach(rows, (row) => decodeItem(row.payload_json))).filter(
          isFyiItem,
        );
      });

      const readMessage = Effect.fn("FyiDelivery.readMessage")(function* (messageId: MessageId) {
        const messages = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_messages
          WHERE message_id = ${messageId}`;
        return messages[0] === undefined
          ? undefined
          : yield* decodeMessage(messages[0].payload_json);
      });

      /** The events that bind an FYI's message and item to `carrier`, or with `null` free them. */
      const carrierEvents = Effect.fn("FyiDelivery.carrierEvents")(function* (
        item: FyiItem,
        carrier: FyiCarrier | null,
      ) {
        const message = yield* readMessage(item.messageId);
        const now = yield* DateTime.now;
        const runId = carrier?.runId ?? null;
        const nodeId = carrier?.nodeId ?? null;
        const event = {
          threadId: item.threadId,
          ...(carrier === null ? {} : { runId: carrier.runId, nodeId: carrier.nodeId }),
          occurredAt: now,
        };
        return [
          ...(message === undefined
            ? []
            : [
                {
                  ...event,
                  id: yield* ids.allocate.event({ threadId: item.threadId }),
                  type: "message.updated" as const,
                  payload: { ...message, runId, nodeId, updatedAt: now },
                },
              ]),
          {
            ...event,
            id: yield* ids.allocate.event({ threadId: item.threadId }),
            type: "turn-item.updated" as const,
            payload: {
              ...item,
              runId,
              nodeId,
              providerThreadId: carrier?.providerThreadId ?? null,
              providerTurnId: null,
              status: carrier === null ? ("pending" as const) : ("completed" as const),
              completedAt: carrier === null ? null : now,
              updatedAt: now,
            },
          },
        ];
      });

      /** Commits only if the item is still exactly the one that was rendered. */
      const bind = Effect.fn("FyiDelivery.bind")(function* (entry: FyiItem, carrier: FyiCarrier) {
        const { committed } = yield* eventSink.writeIfTurnItemUnchanged({
          expected: entry,
          events: yield* carrierEvents(entry, carrier),
        });
        return committed;
      });

      return FyiDelivery.of({
        forTurn: Effect.fn("FyiDelivery.forTurn")(
          function* (input) {
            if (!turnCarriesFyi(input)) return NO_FYI;
            const { text, rendered } = renderForTurn(yield* readWaiting(input.threadId));
            if (rendered.length === 0) return NO_FYI;
            return {
              text,
              carry: (carrier) =>
                Effect.forEach(
                  rendered,
                  (entry) =>
                    bind(entry, carrier).pipe(
                      Effect.flatMap((committed) =>
                        committed
                          ? Effect.void
                          : Effect.logWarning("An FYI message changed before its turn took it", {
                              messageId: entry.messageId,
                              runId: carrier.runId,
                            }),
                      ),
                    ),
                  { concurrency: CARRY_CONCURRENCY, discard: true },
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("FYI delivery was not recorded", {
                      threadId: input.threadId,
                      runId: carrier.runId,
                      cause,
                    }),
                  ),
                ),
            } satisfies TurnFyi;
          },
          Effect.catchCause((cause) =>
            Effect.logWarning("FYI messages were left for a later turn", { cause }).pipe(
              Effect.as(NO_FYI),
            ),
          ),
        ),
        forToolBatch: Effect.fn("FyiDelivery.forToolBatch")(
          function* (input) {
            const { rendered } = renderForToolBatch(yield* readWaiting(input.threadId));
            const bound = yield* Effect.filter(rendered, (entry) =>
              (input.stop() ? Effect.succeed(false) : bind(entry, input.carrier)).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("An FYI message was left for a later tool call", {
                    messageId: entry.messageId,
                    cause,
                  }).pipe(Effect.as(false)),
                ),
              ),
            );
            return bound.length === 0 ? undefined : renderForToolBatch(bound).text;
          },
          Effect.catchCause((cause) =>
            Effect.logWarning("FYI messages were left for a later tool call", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        ),
        unbind: Effect.fn("FyiDelivery.unbind")(
          function* (input) {
            if (input.runIds.length === 0) return [];
            const rows = yield* sql<{ readonly payload_json: string }>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${input.threadId} AND type = 'user_message'
                AND json_extract(payload_json, '$.fyi') = 1
                AND run_id IN ${sql.in(input.runIds)}`;
            const items = (yield* Effect.forEach(rows, (row) =>
              decodeItem(row.payload_json),
            )).filter(isFyiItem);
            return (yield* Effect.forEach(items, (item) => carrierEvents(item, null))).flat();
          },
          Effect.catchCause((cause) =>
            Effect.logWarning("FYI messages of rolled-back runs stay hidden", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(IdAllocator.layer));
