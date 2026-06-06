import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { useAutomationFilters } from "./useAutomationFilters.ts";
import { useAutomationMutations } from "./useAutomationMutations.ts";
import { useAutomationsData } from "./useAutomationsData.ts";
import { useRuleDialogState } from "./useRuleDialogState.ts";

export function useAutomationsController(ctx: PluginUiContext) {
  const projects = ctx.host.useProjects();
  const data = useAutomationsData(ctx);
  const filters = useAutomationFilters(ctx, {
    projects,
    rules: data.rules,
    runs: data.runs,
  });
  const dialog = useRuleDialogState(ctx, projects);
  const mutations = useAutomationMutations(ctx, {
    editingRule: dialog.editingRule,
    form: dialog.form,
    setDialogOpen: dialog.setDialogOpen,
    refreshQuietly: data.refreshQuietly,
  });

  return {
    projects,
    visibleRules: filters.visibleRules,
    visibleRuns: filters.visibleRuns,
    runs: data.runs,
    projectById: filters.projectById,
    ruleById: filters.ruleById,
    loading: data.loading,
    pendingAction: mutations.pendingAction,
    projectFilter: filters.projectFilter,
    statusFilter: filters.statusFilter,
    setProjectFilter: filters.setProjectFilter,
    setStatusFilter: filters.setStatusFilter,
    dialogOpen: dialog.dialogOpen,
    editingRule: dialog.editingRule,
    form: dialog.form,
    updateForm: dialog.updateForm,
    setDialogOpen: dialog.setDialogOpen,
    refresh: data.refresh,
    openCreateDialog: dialog.openCreateDialog,
    openEditDialog: dialog.openEditDialog,
    submitForm: mutations.submitForm,
    updateRuleEnabled: mutations.updateRuleEnabled,
    runNow: mutations.runNow,
    deleteRule: mutations.deleteRule,
  };
}
