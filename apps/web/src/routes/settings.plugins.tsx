import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettingsPanel } from "../components/settings/plugins/PluginsSettings";

function SettingsPluginsRoute() {
  return <PluginsSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
});
