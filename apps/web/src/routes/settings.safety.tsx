import { createFileRoute } from "@tanstack/react-router";

import { SafetySettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/safety")({
  component: SafetySettingsPanel,
});
