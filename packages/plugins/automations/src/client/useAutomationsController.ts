import type {
  AutomationRule,
  AutomationRun,
  AutomationsRulesCreateResult,
  AutomationsRulesListResult,
  AutomationsRulesRunNowResult,
  AutomationsRulesUpdateResult,
  AutomationsRunsListRecentResult,
} from "../shared/schema.ts";
import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { AUTOMATIONS_COMMANDS } from "../shared/constants.ts";
import { commandErrorMessage, emptyForm, filterRules, formFromRule } from "./domain.ts";
import type { RuleFormState, RuleStatusFilter } from "./types.ts";

export function useAutomationsController(ctx: PluginUiContext) {
  const React = ctx.react;
  const projects = ctx.host.useProjects();
  const [rules, setRules] = React.useState<ReadonlyArray<AutomationRule>>([]);
  const [runs, setRuns] = React.useState<ReadonlyArray<AutomationRun>>([]);
  const [loading, setLoading] = React.useState(true);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [projectFilter, setProjectFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState<RuleStatusFilter>("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingRule, setEditingRule] = React.useState<AutomationRule | null>(null);
  const [form, setForm] = React.useState<RuleFormState>(() => emptyForm(projects[0]?.id ?? ""));

  const projectById = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const ruleById = React.useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rulesResult, runsResult] = await Promise.all([
        ctx.api.invoke<AutomationsRulesListResult>(AUTOMATIONS_COMMANDS.rulesList, {}),
        ctx.api.invoke<AutomationsRunsListRecentResult>(AUTOMATIONS_COMMANDS.runsListRecent, {
          limit: 500,
        }),
      ]);
      setRules(rulesResult.rules);
      setRuns(runsResult.runs);
    } catch (error) {
      ctx.toast.error("Could not load automations", commandErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleRules = React.useMemo(
    () => filterRules({ rules, projectFilter, statusFilter }),
    [projectFilter, rules, statusFilter],
  );
  const visibleRuleIds = React.useMemo(
    () => new Set(visibleRules.map((rule) => rule.id)),
    [visibleRules],
  );
  const visibleRuns = React.useMemo(
    () => runs.filter((run) => visibleRuleIds.has(run.ruleId)).slice(0, 100),
    [runs, visibleRuleIds],
  );

  const updateForm = React.useCallback((patch: Partial<RuleFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  const openCreateDialog = React.useCallback(() => {
    setEditingRule(null);
    setForm(emptyForm(projects[0]?.id ?? ""));
    setDialogOpen(true);
  }, [projects]);

  const openEditDialog = React.useCallback((rule: AutomationRule) => {
    setEditingRule(rule);
    setForm(formFromRule(rule));
    setDialogOpen(true);
  }, []);

  const submitForm = React.useCallback(async () => {
    const name = form.name.trim();
    const cron = form.cron.trim();
    const timezone = form.timezone.trim();
    const prompt = form.prompt.trim();
    if (!name || !form.projectId || !cron || !timezone || !prompt) {
      ctx.toast.error(
        "Automation is incomplete",
        "Name, project, cron, timezone, and prompt are required.",
      );
      return;
    }

    setPendingAction("form");
    try {
      if (editingRule) {
        await ctx.api.invoke<AutomationsRulesUpdateResult>(AUTOMATIONS_COMMANDS.rulesUpdate, {
          ruleId: editingRule.id,
          patch: {
            name,
            enabled: form.enabled,
            projectId: form.projectId,
            cron,
            timezone,
            prompt,
          },
        });
        ctx.toast.success("Automation updated");
      } else {
        await ctx.api.invoke<AutomationsRulesCreateResult>(AUTOMATIONS_COMMANDS.rulesCreate, {
          name,
          enabled: form.enabled,
          projectId: form.projectId,
          cron,
          timezone,
          prompt,
        });
        ctx.toast.success("Automation created");
      }
      setDialogOpen(false);
      await refresh();
    } catch (error) {
      ctx.toast.error("Could not save automation", commandErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }, [ctx, editingRule, form, refresh]);

  const updateRuleEnabled = React.useCallback(
    async (rule: AutomationRule, enabled: boolean) => {
      setPendingAction(`toggle:${rule.id}`);
      try {
        await ctx.api.invoke<AutomationsRulesUpdateResult>(AUTOMATIONS_COMMANDS.rulesUpdate, {
          ruleId: rule.id,
          patch: { enabled },
        });
        await refresh();
      } catch (error) {
        ctx.toast.error("Could not update automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refresh],
  );

  const runNow = React.useCallback(
    async (rule: AutomationRule) => {
      setPendingAction(`run:${rule.id}`);
      try {
        const result = await ctx.api.invoke<AutomationsRulesRunNowResult>(
          AUTOMATIONS_COMMANDS.rulesRunNow,
          {
            ruleId: rule.id,
          },
        );
        ctx.toast.success(
          result.run.status === "skipped" ? "Automation skipped" : "Automation started",
        );
        await refresh();
      } catch (error) {
        ctx.toast.error("Could not run automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refresh],
  );

  const deleteRule = React.useCallback(
    async (rule: AutomationRule) => {
      const confirmed = await ctx.host.confirm(`Delete "${rule.name}" and all of its run history?`);
      if (!confirmed) {
        return;
      }

      setPendingAction(`delete:${rule.id}`);
      try {
        await ctx.api.invoke(AUTOMATIONS_COMMANDS.rulesDelete, { ruleId: rule.id });
        ctx.toast.success("Automation deleted");
        await refresh();
      } catch (error) {
        ctx.toast.error("Could not delete automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refresh],
  );

  return {
    projects,
    visibleRules,
    visibleRuns,
    runs,
    projectById,
    ruleById,
    loading,
    pendingAction,
    projectFilter,
    statusFilter,
    setProjectFilter,
    setStatusFilter,
    dialogOpen,
    editingRule,
    form,
    updateForm,
    setDialogOpen,
    refresh,
    openCreateDialog,
    openEditDialog,
    submitForm,
    updateRuleEnabled,
    runNow,
    deleteRule,
  };
}
