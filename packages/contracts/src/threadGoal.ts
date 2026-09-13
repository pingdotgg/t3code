import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: Schema.Literals([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  timeUsedSeconds: Schema.NullOr(NonNegativeInt),
  tokensUsed: Schema.NullOr(NonNegativeInt),
  tokenBudget: Schema.NullOr(PositiveInt),
  rounds: Schema.optional(NonNegativeInt),
  lastReason: Schema.optional(Schema.String),
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalSetInput = Schema.Struct({
  objective: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4000))),
  status: Schema.optional(Schema.Literals(["active", "paused"])),
  tokenBudget: Schema.optional(Schema.NullOr(PositiveInt)),
});
export type ThreadGoalSetInput = typeof ThreadGoalSetInput.Type;
