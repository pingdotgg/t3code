import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CODEX_GOAL_OBJECTIVE_MAX_CHARS = 4_000;
const CodexGoalObjective = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (objective) =>
      Array.from(objective).length <= CODEX_GOAL_OBJECTIVE_MAX_CHARS ||
      `Goal objective must not exceed ${CODEX_GOAL_OBJECTIVE_MAX_CHARS} characters.`,
  ),
);
export const CodexGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type CodexGoalStatus = typeof CodexGoalStatus.Type;
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
export const CodexGoalSubscriptionInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});
export type CodexGoalSubscriptionInput = typeof CodexGoalSubscriptionInput.Type;
export const CodexGoalSetInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optionalKey(CodexGoalObjective),
  status: Schema.optionalKey(CodexGoalStatus),
  tokenBudget: Schema.optionalKey(Schema.NullOr(PositiveInt)),
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
