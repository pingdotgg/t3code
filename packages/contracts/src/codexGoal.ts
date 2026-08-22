import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodexGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type CodexGoalStatus = typeof CodexGoalStatus.Type;

/** Native Codex App Server Goal state, excluding its provider-local thread id. */
export const CodexGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: CodexGoalStatus,
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
});
export type CodexGoal = typeof CodexGoal.Type;

export const CodexGoalThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type CodexGoalThreadInput = typeof CodexGoalThreadInput.Type;

export const CodexGoalSetInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optionalKey(TrimmedNonEmptyString),
  status: Schema.optionalKey(CodexGoalStatus),
  tokenBudget: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type CodexGoalSetInput = typeof CodexGoalSetInput.Type;

export const CodexGoalClearResult = Schema.Struct({
  cleared: Schema.Boolean,
});
export type CodexGoalClearResult = typeof CodexGoalClearResult.Type;

export const CodexGoalStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    threadId: ThreadId,
    goal: Schema.NullOr(CodexGoal),
  }),
  Schema.Struct({
    type: Schema.Literal("updated"),
    threadId: ThreadId,
    goal: CodexGoal,
  }),
  Schema.Struct({
    type: Schema.Literal("cleared"),
    threadId: ThreadId,
  }),
]);
export type CodexGoalStreamEvent = typeof CodexGoalStreamEvent.Type;

export const CodexGoalOperation = Schema.Literals(["get", "set", "clear", "subscribe"]);
export type CodexGoalOperation = typeof CodexGoalOperation.Type;

export class CodexGoalOperationError extends Schema.TaggedErrorClass<CodexGoalOperationError>()(
  "CodexGoalOperationError",
  {
    operation: CodexGoalOperation,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Codex Goal ${this.operation} failed for thread ${this.threadId}`;
  }
}
