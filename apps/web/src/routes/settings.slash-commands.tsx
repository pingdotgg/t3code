import { createFileRoute } from "@tanstack/react-router";

import { ProviderSlashCommandsSection } from "../components/settings/ProviderSlashCommandsSection";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsSlashCommandsRoute() {
  return (
    <SettingsPageContainer className="max-w-5xl">
      <ProviderSlashCommandsSection />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/slash-commands")({
  component: SettingsSlashCommandsRoute,
});
