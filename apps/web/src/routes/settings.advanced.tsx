import { createFileRoute } from "@tanstack/react-router";

import { AdvancedSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSettingsPanel,
});
