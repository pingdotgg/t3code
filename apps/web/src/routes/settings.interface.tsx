import { createFileRoute } from "@tanstack/react-router";

import { InterfaceSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/interface")({
  component: InterfaceSettingsPanel,
});
