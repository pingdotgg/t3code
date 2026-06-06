import type { PluginUiContext, PluginUiProject } from "@t3tools/plugin-api/ui";

import type { AutomationRule } from "../shared/schema.ts";
import { emptyForm, formFromRule } from "./domain.ts";
import type { RuleFormState } from "./types.ts";

export function useRuleDialogState(ctx: PluginUiContext, projects: ReadonlyArray<PluginUiProject>) {
  const React = ctx.react;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingRule, setEditingRule] = React.useState<AutomationRule | null>(null);
  const [form, setForm] = React.useState<RuleFormState>(() => emptyForm(projects[0]?.id ?? ""));

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

  return {
    dialogOpen,
    editingRule,
    form,
    setDialogOpen,
    updateForm,
    openCreateDialog,
    openEditDialog,
  } as const;
}
