import * as Effect from "effect/Effect";

import type { AutomationRuleId } from "../shared/schema.ts";

export const releaseActiveRule = (activeRuleIds: Set<AutomationRuleId>, ruleId: AutomationRuleId) =>
  Effect.sync(() => {
    activeRuleIds.delete(ruleId);
  });

export const markActiveRule = (activeRuleIds: Set<AutomationRuleId>, ruleId: AutomationRuleId) =>
  Effect.sync(() => {
    activeRuleIds.add(ruleId);
  });
