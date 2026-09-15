import * as Schema from "effect/Schema";

const WaitMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }));

export const CodeModeExecInput = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
  clientRequestId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  yieldAfterMs: Schema.optional(WaitMs),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 }))),
});

export const CodeModeWaitInput = Schema.Struct({
  executionId: Schema.String,
  waitMs: Schema.optional(WaitMs),
  includeCalls: Schema.optional(Schema.Boolean),
});

export const CodeModeCancelInput = Schema.Struct({ executionId: Schema.String });

export const CodeModeCall = Schema.Struct({
  tool: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  result: Schema.Unknown,
});
export type CodeModeCall = typeof CodeModeCall.Type;

export const CodeModeExecutionResult = Schema.Struct({
  executionId: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  result: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  logs: Schema.Array(Schema.String),
  calls: Schema.Array(CodeModeCall),
});
export type CodeModeExecutionResult = typeof CodeModeExecutionResult.Type;
