import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { FilterBar } from "./components/FilterBar.tsx";
import { RuleDialog } from "./components/RuleDialog.tsx";
import { RulesSection } from "./components/RulesSection.tsx";
import { RunsSection } from "./components/RunsSection.tsx";
import { useAutomationsController } from "./useAutomationsController.ts";

export function AutomationsPage({ ctx }: { readonly ctx: PluginUiContext }) {
  const React = ctx.react;
  const C = ctx.components;
  const controller = useAutomationsController(ctx);

  return (
    <C.Page
      actions={
        <React.Fragment>
          <C.Button
            disabled={controller.loading}
            onClick={() => {
              void controller.refresh();
            }}
          >
            {controller.loading ? "Refreshing" : "Refresh"}
          </C.Button>
          <C.Button
            disabled={controller.projects.length === 0}
            onClick={controller.openCreateDialog}
            variant="primary"
          >
            New
          </C.Button>
        </React.Fragment>
      }
      title="Automations"
    >
      <FilterBar
        ctx={ctx}
        projectFilter={controller.projectFilter}
        projects={controller.projects}
        setProjectFilter={controller.setProjectFilter}
        setStatusFilter={controller.setStatusFilter}
        statusFilter={controller.statusFilter}
        visibleRuleCount={controller.visibleRules.length}
      />
      <RulesSection
        ctx={ctx}
        loading={controller.loading}
        pendingAction={controller.pendingAction}
        projectById={controller.projectById}
        rules={controller.visibleRules}
        runs={controller.runs}
        onDelete={(rule) => {
          void controller.deleteRule(rule);
        }}
        onEdit={controller.openEditDialog}
        onRunNow={(rule) => {
          void controller.runNow(rule);
        }}
        onToggleEnabled={(rule, enabled) => {
          void controller.updateRuleEnabled(rule, enabled);
        }}
      />
      <RunsSection
        ctx={ctx}
        projectById={controller.projectById}
        ruleById={controller.ruleById}
        runs={controller.visibleRuns}
      />
      <RuleDialog
        ctx={ctx}
        editingRule={controller.editingRule}
        form={controller.form}
        open={controller.dialogOpen}
        pendingAction={controller.pendingAction}
        projects={controller.projects}
        onClose={() => controller.setDialogOpen(false)}
        onFormChange={controller.updateForm}
        onSubmit={() => {
          void controller.submitForm();
        }}
      />
    </C.Page>
  );
}
