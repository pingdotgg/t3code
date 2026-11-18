import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const UsageUsd = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** Spend in one window. A null limit means the window has none. */
export const UsageBudgetWindow = Schema.Struct({
  costUsd: UsageUsd,
  softLimitUsd: Schema.NullOr(UsageUsd),
  hardLimitUsd: Schema.NullOr(UsageUsd),
});
export type UsageBudgetWindow = typeof UsageBudgetWindow.Type;

/** Spend across every agent session on this machine, as the configured usage budget command prints it. */
export const UsageBudgetStatus = Schema.Struct({
  state: Schema.Literals(["normal", "soft", "hard", "override"]),
  /** The last 60 minutes. */
  hour: UsageBudgetWindow,
  /** Since local midnight. */
  day: Schema.Struct({ ...UsageBudgetWindow.fields, resetsAt: IsoDateTime }),
  overrideUntil: Schema.NullOr(IsoDateTime),
  /** Cache reads as a share of today's prompt tokens; null before the first response. */
  cacheHitPercent: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
});
export type UsageBudgetStatus = typeof UsageBudgetStatus.Type;

export class UsageBudgetError extends Schema.TaggedError<UsageBudgetError>()("UsageBudgetError", {
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage budget read failed: ${this.detail}`;
  }
}
