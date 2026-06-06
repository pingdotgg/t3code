import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/plugin-api/schema";
import * as Schema from "effect/Schema";

const IANA_TIMEZONE_MAX_CHARS = 128;

export const AutomationRuleId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationRuleId"));
export type AutomationRuleId = typeof AutomationRuleId.Type;

export const AutomationRunId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationRunId"));
export type AutomationRunId = typeof AutomationRunId.Type;

export const IanaTimezone = TrimmedNonEmptyString.check(
  Schema.isMaxLength(IANA_TIMEZONE_MAX_CHARS),
);
export type IanaTimezone = typeof IanaTimezone.Type;

export const AutomationRuleScheduleState = Schema.Struct({
  nextRunAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutomationRuleScheduleState = typeof AutomationRuleScheduleState.Type;

export const AutomationRule = Schema.Struct({
  id: AutomationRuleId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  cron: TrimmedNonEmptyString,
  timezone: IanaTimezone,
  prompt: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  scheduleState: Schema.optional(AutomationRuleScheduleState),
});
export type AutomationRule = typeof AutomationRule.Type;

export const AutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRunReason = Schema.Literals(["manual", "schedule", "previous-run-active"]);
export type AutomationRunReason = typeof AutomationRunReason.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  ruleId: AutomationRuleId,
  status: AutomationRunStatus,
  reason: Schema.optional(AutomationRunReason),
  threadId: Schema.optional(ThreadId),
  scheduledFor: IsoDateTime,
  ruleUpdatedAt: Schema.optional(IsoDateTime),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationsRulesListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  enabled: Schema.optional(Schema.Boolean),
});
export type AutomationsRulesListInput = typeof AutomationsRulesListInput.Type;

export const AutomationsRulesListResult = Schema.Struct({
  rules: Schema.Array(AutomationRule),
});
export type AutomationsRulesListResult = typeof AutomationsRulesListResult.Type;

export const AutomationsRulesCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  enabled: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  cron: TrimmedNonEmptyString,
  timezone: IanaTimezone,
  prompt: TrimmedNonEmptyString,
});
export type AutomationsRulesCreateInput = typeof AutomationsRulesCreateInput.Type;

export const AutomationsRulesCreateResult = Schema.Struct({
  rule: AutomationRule,
});
export type AutomationsRulesCreateResult = typeof AutomationsRulesCreateResult.Type;

export const AutomationsRulesUpdateInput = Schema.Struct({
  ruleId: AutomationRuleId,
  patch: Schema.Struct({
    name: Schema.optional(TrimmedNonEmptyString),
    enabled: Schema.optional(Schema.Boolean),
    projectId: Schema.optional(ProjectId),
    cron: Schema.optional(TrimmedNonEmptyString),
    timezone: Schema.optional(IanaTimezone),
    prompt: Schema.optional(TrimmedNonEmptyString),
  }),
});
export type AutomationsRulesUpdateInput = typeof AutomationsRulesUpdateInput.Type;

export const AutomationsRulesUpdateResult = Schema.Struct({
  rule: AutomationRule,
});
export type AutomationsRulesUpdateResult = typeof AutomationsRulesUpdateResult.Type;

export const AutomationsRulesDeleteInput = Schema.Struct({
  ruleId: AutomationRuleId,
});
export type AutomationsRulesDeleteInput = typeof AutomationsRulesDeleteInput.Type;

export const AutomationsRulesDeleteResult = Schema.Struct({});
export type AutomationsRulesDeleteResult = typeof AutomationsRulesDeleteResult.Type;

export const AutomationsRulesRunNowInput = Schema.Struct({
  ruleId: AutomationRuleId,
});
export type AutomationsRulesRunNowInput = typeof AutomationsRulesRunNowInput.Type;

export const AutomationsRulesRunNowResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationsRulesRunNowResult = typeof AutomationsRulesRunNowResult.Type;

export const AutomationsRunsListRecentInput = Schema.Struct({
  ruleId: Schema.optional(AutomationRuleId),
  limit: Schema.optional(NonNegativeInt),
});
export type AutomationsRunsListRecentInput = typeof AutomationsRunsListRecentInput.Type;

export const AutomationsRunsListRecentResult = Schema.Struct({
  runs: Schema.Array(AutomationRun),
});
export type AutomationsRunsListRecentResult = typeof AutomationsRunsListRecentResult.Type;
