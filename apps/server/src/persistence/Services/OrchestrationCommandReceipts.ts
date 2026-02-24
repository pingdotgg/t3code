import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

export interface OrchestrationCommandReceiptRepositoryShape {
  readonly upsert: (
    receipt: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

export class OrchestrationCommandReceiptRepository extends ServiceMap.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()("persistence/OrchestrationCommandReceiptRepository") {}
