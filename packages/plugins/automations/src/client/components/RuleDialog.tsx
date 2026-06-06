import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import { DEFAULT_CRON } from "../../shared/constants.ts";
import type { AutomationRule } from "../../shared/schema.ts";
import { twoColumnStyle } from "../layout.ts";
import type { PluginProject, RuleFormState } from "../types.ts";

export function RuleDialog({
  ctx,
  open,
  editingRule,
  form,
  projects,
  pendingAction,
  onClose,
  onSubmit,
  onFormChange,
}: {
  readonly ctx: PluginUiContext;
  readonly open: boolean;
  readonly editingRule: AutomationRule | null;
  readonly form: RuleFormState;
  readonly projects: ReadonlyArray<PluginProject>;
  readonly pendingAction: string | null;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly onFormChange: (patch: Partial<RuleFormState>) => void;
}) {
  const React = ctx.react;
  const C = ctx.components;

  return (
    <C.Dialog
      description="Schedule a project-scoped prompt that starts a new agent thread."
      footer={
        <React.Fragment>
          <C.Button onClick={onClose}>Cancel</C.Button>
          <C.Button disabled={pendingAction === "form"} onClick={onSubmit} variant="primary">
            {editingRule ? "Save" : "Create"}
          </C.Button>
        </React.Fragment>
      }
      open={open}
      title={editingRule ? "Edit Automation" : "New Automation"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <C.Stack gap="md">
        <C.Field label="Name">
          <C.Input
            autoFocus
            placeholder="Weekly cleanup"
            value={form.name}
            onValueChange={(name) => onFormChange({ name })}
          />
        </C.Field>
        <div style={twoColumnStyle}>
          <C.Field label="Project">
            <C.Select
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              value={form.projectId}
              onValueChange={(projectId) => onFormChange({ projectId })}
            />
          </C.Field>
          <C.Field label="Timezone">
            <C.Input
              placeholder="Europe/Berlin"
              value={form.timezone}
              onValueChange={(timezone) => onFormChange({ timezone })}
            />
          </C.Field>
        </div>
        <div style={twoColumnStyle}>
          <C.Field label="Cron">
            <C.Input
              placeholder={DEFAULT_CRON}
              value={form.cron}
              onValueChange={(cron) => onFormChange({ cron })}
            />
          </C.Field>
          <C.Stack align="start" style={{ alignSelf: "end" }}>
            <C.Switch
              checked={form.enabled}
              label="Enabled"
              onCheckedChange={(enabled) => onFormChange({ enabled })}
            />
          </C.Stack>
        </div>
        <C.Field label="Prompt">
          <C.TextArea
            placeholder="Inspect the project and suggest the most useful maintenance task."
            rows={5}
            value={form.prompt}
            onValueChange={(prompt) => onFormChange({ prompt })}
          />
        </C.Field>
      </C.Stack>
    </C.Dialog>
  );
}
