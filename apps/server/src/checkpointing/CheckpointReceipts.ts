import type { CheckpointRef, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RuntimeReceiptBusShape } from "../orchestration/Services/RuntimeReceiptBus.ts";

export function publishCheckpointTerminalReceipts(
  receiptBus: RuntimeReceiptBusShape,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly checkpointTurnCount: number;
    readonly checkpointRef: CheckpointRef;
    readonly status: "ready" | "missing" | "error";
    readonly createdAt: string;
  },
) {
  return Effect.all(
    [
      receiptBus.publish({
        type: "checkpoint.diff.finalized",
        ...input,
      }),
      receiptBus.publish({
        type: "turn.processing.quiesced",
        threadId: input.threadId,
        turnId: input.turnId,
        checkpointTurnCount: input.checkpointTurnCount,
        createdAt: input.createdAt,
      }),
    ],
    { discard: true },
  );
}
