import { createFileRoute } from "@tanstack/react-router";

import { PluginSettingsPanel } from "../components/settings/PluginSettingsPanel";

export const Route = createFileRoute("/settings/plugins")({
  component: PluginSettingsPanel,
});
