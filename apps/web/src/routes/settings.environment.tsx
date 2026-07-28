import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsEnvironmentRoute() {
  return <EnvironmentSettingsPanel />;
}

export const Route = createFileRoute("/settings/environment")({
  component: SettingsEnvironmentRoute,
});
