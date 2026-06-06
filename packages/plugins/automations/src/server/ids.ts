import { randomUUID } from "node:crypto";

import { AutomationRuleId, AutomationRunId } from "../shared/schema.ts";

export function nextRuleId(): AutomationRuleId {
  return AutomationRuleId.make(`rule-${randomUUID()}`);
}

export function nextRunId(): AutomationRunId {
  return AutomationRunId.make(`run-${randomUUID()}`);
}

export function scheduledRunId(ruleId: AutomationRuleId, scheduledFor: string): AutomationRunId {
  return AutomationRunId.make(`run-schedule:${ruleId}:${scheduledFor}`);
}
