import { CheckpointRef, IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";
import {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "./RuntimeReceiptBus.shared.ts";

const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly stream: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends ServiceMap.Service<
  RuntimeReceiptBus,
  RuntimeReceiptBusShape
>()("t3/orchestration/Services/RuntimeReceiptBus") {}
