import { createFileRoute } from "@tanstack/react-router";

import { ProjectDefaultsSettings } from "../components/settings/ProjectDefaultsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsActionsRoute() {
  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="actions" />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/actions")({ component: SettingsActionsRoute });
