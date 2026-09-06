import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { TerminalCols, TerminalId, TerminalRows, TerminalSessionStatus } from "./terminal.ts";

export const TERMINAL_MCP_DEFAULT_LIST_LIMIT = 20;
export const TERMINAL_MCP_MAX_LIST_LIMIT = 50;
export const TERMINAL_MCP_DEFAULT_OUTPUT_CHARS = 6_000;
export const TERMINAL_MCP_MAX_OUTPUT_CHARS = 20_000;

const ListLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(TERMINAL_MCP_MAX_LIST_LIMIT),
);
const OutputLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(TERMINAL_MCP_MAX_OUTPUT_CHARS),
);
const TargetThreadFields = {
  threadId: Schema.optional(ThreadId),
};
const TargetTerminalFields = {
  ...TargetThreadFields,
  terminalId: TerminalId,
};

export const TerminalMcpListInput = Schema.Struct({
  ...TargetThreadFields,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(ListLimit),
});
export type TerminalMcpListInput = typeof TerminalMcpListInput.Type;

export const TerminalMcpReadInput = Schema.Struct({
  ...TargetTerminalFields,
  maxChars: Schema.optional(OutputLimit),
});
export type TerminalMcpReadInput = typeof TerminalMcpReadInput.Type;

export const TerminalMcpOpenInput = Schema.Struct({
  ...TargetTerminalFields,
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
});
export type TerminalMcpOpenInput = typeof TerminalMcpOpenInput.Type;

export const TerminalMcpWriteInput = Schema.Struct({
  ...TargetTerminalFields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalMcpWriteInput = typeof TerminalMcpWriteInput.Type;

export const TerminalMcpResizeInput = Schema.Struct({
  ...TargetTerminalFields,
  cols: TerminalCols,
  rows: TerminalRows,
});
export type TerminalMcpResizeInput = typeof TerminalMcpResizeInput.Type;

export const TerminalMcpClearInput = Schema.Struct(TargetTerminalFields);
export type TerminalMcpClearInput = typeof TerminalMcpClearInput.Type;

export const TerminalMcpRestartInput = Schema.Struct({
  ...TargetTerminalFields,
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
});
export type TerminalMcpRestartInput = typeof TerminalMcpRestartInput.Type;

export const TerminalMcpCloseInput = Schema.Struct(TargetTerminalFields);
export type TerminalMcpCloseInput = typeof TerminalMcpCloseInput.Type;

export const TerminalMcpSummary = Schema.Struct({
  terminalId: TerminalId,
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String,
  updatedAt: Schema.String,
});
export type TerminalMcpSummary = typeof TerminalMcpSummary.Type;

export const TerminalMcpOutputWindow = Schema.Struct({
  text: Schema.String,
  retainedChars: NonNegativeInt,
  startOffset: NonNegativeInt,
  endOffset: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type TerminalMcpOutputWindow = typeof TerminalMcpOutputWindow.Type;

export const TerminalMcpSession = Schema.Struct({
  ...TerminalMcpSummary.fields,
  threadId: ThreadId,
  sequence: NonNegativeInt,
  output: TerminalMcpOutputWindow,
});
export type TerminalMcpSession = typeof TerminalMcpSession.Type;

export const TerminalMcpListResult = Schema.Struct({
  threadId: ThreadId,
  terminals: Schema.Array(TerminalMcpSummary),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
  historyAvailability: Schema.Literal("loaded_sessions_only"),
});
export type TerminalMcpListResult = typeof TerminalMcpListResult.Type;

export const TerminalMcpReadResult = TerminalMcpSession;
export type TerminalMcpReadResult = typeof TerminalMcpReadResult.Type;

export const TerminalMcpOpenResult = Schema.Struct({
  outcome: Schema.Literals(["opened", "already_running"]),
  terminal: TerminalMcpSession,
});
export type TerminalMcpOpenResult = typeof TerminalMcpOpenResult.Type;

export const TerminalMcpAcceptedInputResult = Schema.Struct({
  threadId: ThreadId,
  terminalId: TerminalId,
  accepted: Schema.Literal(true),
  statusAtAcceptance: Schema.Literal("running"),
  lastObservedSequence: NonNegativeInt,
});
export type TerminalMcpAcceptedInputResult = typeof TerminalMcpAcceptedInputResult.Type;

export const TerminalMcpStateResult = Schema.Struct({
  terminal: TerminalMcpSession,
});
export type TerminalMcpStateResult = typeof TerminalMcpStateResult.Type;

export const TerminalMcpCloseResult = Schema.Struct({
  threadId: ThreadId,
  terminalId: TerminalId,
  closed: Schema.Literal(true),
});
export type TerminalMcpCloseResult = typeof TerminalMcpCloseResult.Type;

export const TerminalMcpFailureCode = Schema.Literals([
  "capability_denied",
  "thread_not_found",
  "project_not_found",
  "execution_policy_denied",
  "terminal_not_found",
  "terminal_not_running",
  "terminal_already_exists",
  "operation_failed",
]);
export type TerminalMcpFailureCode = typeof TerminalMcpFailureCode.Type;

export class TerminalMcpFailure extends Schema.TaggedErrorClass<TerminalMcpFailure>()(
  "TerminalMcpFailure",
  {
    code: TerminalMcpFailureCode,
    message: Schema.String,
  },
) {}
