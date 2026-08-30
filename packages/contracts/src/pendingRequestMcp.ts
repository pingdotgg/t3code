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
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const PENDING_REQUEST_MCP_MAX_QUESTIONS = 20;
export const PENDING_REQUEST_MCP_MAX_OPTIONS_PER_QUESTION = 20;
export const PENDING_REQUEST_MCP_MAX_QUESTION_ID_CHARS = 256;
export const PENDING_REQUEST_MCP_MAX_HEADER_CHARS = 256;
export const PENDING_REQUEST_MCP_MAX_QUESTION_CHARS = 4_000;
export const PENDING_REQUEST_MCP_MAX_OPTION_LABEL_CHARS = 256;
export const PENDING_REQUEST_MCP_MAX_OPTION_DESCRIPTION_CHARS = 2_000;
export const PENDING_REQUEST_MCP_MAX_TOTAL_QUESTION_CHARS = 32_000;

const PendingRequestMcpLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(50));
const PendingRequestMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this response." });
const PendingRequestMcpAnswer = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
]);

export const PendingRequestMcpListInput = Schema.Struct({
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))).annotate({
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
      "Answers keyed by the exact question IDs returned by list/read. Every question must be answered; values may be a string, number, boolean, or non-empty string array.",
  }),
  clientRequestId: Schema.optional(PendingRequestMcpClientRequestId),
});
export type PendingRequestMcpRespondInput = typeof PendingRequestMcpRespondInput.Type;

const PendingRequestMcpQuestion = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_QUESTION_ID_CHARS)),
  header: TrimmedNonEmptyString.check(Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_HEADER_CHARS)),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_QUESTION_CHARS)),
  options: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString.check(
        Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_OPTION_LABEL_CHARS),
      ),
      description: TrimmedNonEmptyString.check(
        Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_OPTION_DESCRIPTION_CHARS),
      ),
    }),
  ).check(Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_OPTIONS_PER_QUESTION)),
});

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
  answerable: Schema.Boolean,
  questionCount: NonNegativeInt,
  questionPayloadStatus: Schema.Literals(["complete", "too_large"]),
  questions: Schema.Array(PendingRequestMcpQuestion).check(
    Schema.isMaxLength(PENDING_REQUEST_MCP_MAX_QUESTIONS),
  ),
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
      "request_payload_too_large",
      "operation_rejected",
      "orchestration_error",
    ]),
    message: Schema.String,
  },
) {}
