import { Input } from "../ui/input";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import {
  deriveDefaultEnvironmentLabel,
  formatEnvironmentDraftTarget,
  type EnvironmentWizardDraft,
} from "./AddEnvironmentDialog.logic";

export function EnvironmentConfirmationStep({
  draft,
  disabled,
  onLabelChange,
}: {
  readonly draft: EnvironmentWizardDraft;
  readonly disabled: boolean;
  readonly onLabelChange: (label: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-border/80 bg-muted/30 p-4">
        <h3 className="text-sm font-semibold">{formatEnvironmentDraftTarget(draft)}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {draft.type === "remote" ? "Direct or relay backend connection" : "SSH tunnel"}
        </p>
      </div>
      <SettingsGroup variant="plain">
        <SettingsRow
          title={<label htmlFor="env-custom-label">Display label</label>}
          description="Custom name shown in the environment list."
          control={
            <Input
              id="env-custom-label"
              value={draft.label}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder={deriveDefaultEnvironmentLabel(draft)}
              disabled={disabled}
              spellCheck={false}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
