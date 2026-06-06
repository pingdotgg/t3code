import type { PluginUiContext, PluginUiProject } from "@t3tools/plugin-api/ui";

import type { AutomationRule, AutomationRun } from "../shared/schema.ts";
import { filterRules } from "./domain.ts";
import type { RuleStatusFilter } from "./types.ts";

export function useAutomationFilters(
  ctx: PluginUiContext,
  input: {
    readonly projects: ReadonlyArray<PluginUiProject>;
    readonly rules: ReadonlyArray<AutomationRule>;
    readonly runs: ReadonlyArray<AutomationRun>;
  },
) {
  const React = ctx.react;
  const [projectFilter, setProjectFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState<RuleStatusFilter>("all");
  const projectById = React.useMemo(
    () => new Map(input.projects.map((project) => [project.id, project])),
    [input.projects],
  );
  const ruleById = React.useMemo(
    () => new Map(input.rules.map((rule) => [rule.id, rule])),
    [input.rules],
  );
  const visibleRules = React.useMemo(
    () => filterRules({ rules: input.rules, projectFilter, statusFilter }),
    [input.rules, projectFilter, statusFilter],
  );
  const visibleRuleIds = React.useMemo(
    () => new Set(visibleRules.map((rule) => rule.id)),
    [visibleRules],
  );
  const visibleRuns = React.useMemo(
    () => input.runs.filter((run) => visibleRuleIds.has(run.ruleId)).slice(0, 100),
    [input.runs, visibleRuleIds],
  );

  return {
    projectById,
    ruleById,
    visibleRules,
    visibleRuns,
    projectFilter,
    statusFilter,
    setProjectFilter,
    setStatusFilter,
  } as const;
}
