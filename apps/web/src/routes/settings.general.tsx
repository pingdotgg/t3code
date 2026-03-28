import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsPanel,
});
