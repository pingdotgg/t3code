import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const PendingRequestMcpLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(50));
const PendingRequestMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this response." });
const PendingRequestMcpAnswer = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
]);

export const PendingRequestMcpListInput = Schema.Struct({
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotate({
    description: "Opaque cursor returned by the previous list page.",
  }),
  limit: Schema.optional(PendingRequestMcpLimit),
});
export type PendingRequestMcpListInput = typeof PendingRequestMcpListInput.Type;

export const PendingRequestMcpReadInput = Schema.Struct({
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
});
export type PendingRequestMcpReadInput = typeof PendingRequestMcpReadInput.Type;

export const PendingRequestMcpRespondInput = Schema.Struct({
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
  answers: Schema.Record(TrimmedNonEmptyString, PendingRequestMcpAnswer).annotate({
    description:
      "Answers keyed by the exact question IDs returned by list/read. Every question must be answered; values may be one string or a non-empty string array.",
  }),
  clientRequestId: Schema.optional(PendingRequestMcpClientRequestId),
});
export type PendingRequestMcpRespondInput = typeof PendingRequestMcpRespondInput.Type;

export const PendingRequestMcpRequest = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  requestId: RuntimeRequestId,
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  status: Schema.Literals(["pending", "resolved", "expired", "cancelled"]),
  resumable: Schema.Boolean,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type PendingRequestMcpRequest = typeof PendingRequestMcpRequest.Type;

export const PendingRequestMcpListResult = Schema.Struct({
  requests: Schema.Array(PendingRequestMcpRequest),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type PendingRequestMcpListResult = typeof PendingRequestMcpListResult.Type;

export const PendingRequestMcpReadResult = PendingRequestMcpRequest;
export type PendingRequestMcpReadResult = typeof PendingRequestMcpReadResult.Type;

export const PendingRequestMcpRespondResult = Schema.Struct({
  commandId: CommandId,
  receiptSequence: NonNegativeInt,
  replayed: Schema.Boolean,
  request: PendingRequestMcpRequest,
});
export type PendingRequestMcpRespondResult = typeof PendingRequestMcpRespondResult.Type;

export class PendingRequestMcpFailure extends Schema.TaggedErrorClass<PendingRequestMcpFailure>()(
  "PendingRequestMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "child_not_found",
      "request_not_found",
      "wrong_request_kind",
      "request_not_pending",
      "request_not_resumable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "invalid_request",
      "invalid_answers",
      "operation_rejected",
      "orchestration_error",
    ]),
    message: Schema.String,
  },
) {}
