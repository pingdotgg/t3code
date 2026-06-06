import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { AUTOMATIONS_COMMANDS } from "../shared/constants.ts";
import type {
  AutomationRule,
  AutomationsRulesCreateResult,
  AutomationsRulesRunNowResult,
  AutomationsRulesUpdateResult,
} from "../shared/schema.ts";
import { commandErrorMessage } from "./domain.ts";
import type { RuleFormState } from "./types.ts";

export function useAutomationMutations(
  ctx: PluginUiContext,
  input: {
    readonly editingRule: AutomationRule | null;
    readonly form: RuleFormState;
    readonly setDialogOpen: (open: boolean) => void;
    readonly refreshQuietly: () => Promise<void>;
  },
) {
  const React = ctx.react;
  const { editingRule, form, refreshQuietly, setDialogOpen } = input;
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

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
      await refreshQuietly();
    } catch (error) {
      ctx.toast.error("Could not save automation", commandErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }, [ctx, editingRule, form, refreshQuietly, setDialogOpen]);

  const updateRuleEnabled = React.useCallback(
    async (rule: AutomationRule, enabled: boolean) => {
      setPendingAction(`toggle:${rule.id}`);
      try {
        await ctx.api.invoke<AutomationsRulesUpdateResult>(AUTOMATIONS_COMMANDS.rulesUpdate, {
          ruleId: rule.id,
          patch: { enabled },
        });
        await refreshQuietly();
      } catch (error) {
        ctx.toast.error("Could not update automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refreshQuietly],
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
        await refreshQuietly();
      } catch (error) {
        ctx.toast.error("Could not run automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refreshQuietly],
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
        await refreshQuietly();
      } catch (error) {
        ctx.toast.error("Could not delete automation", commandErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [ctx, refreshQuietly],
  );

  return {
    pendingAction,
    submitForm,
    updateRuleEnabled,
    runNow,
    deleteRule,
  } as const;
}
