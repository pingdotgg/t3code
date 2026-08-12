import { WorkflowIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AgenticOperatorSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agentic Operator" icon={<WorkflowIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("agentic-operator")}
          description="Allow agents to create and coordinate model-specific T3 Code tasks."
          control={
            <Switch
              checked={settings.agenticOperatorEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ agenticOperatorEnabled: Boolean(checked) })
              }
              aria-label="Enable Agentic Operator"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
