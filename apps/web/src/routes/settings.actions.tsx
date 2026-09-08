import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProjectDefaultsSettings } from "../components/settings/ProjectDefaultsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsActionsRoute() {
  const { scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings
        environmentId={scope.kind === "environment" ? scope.environmentId : null}
        category="actions"
      />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/actions")({ component: SettingsActionsRoute });
