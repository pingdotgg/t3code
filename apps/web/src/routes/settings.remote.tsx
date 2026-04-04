import { createFileRoute } from "@tanstack/react-router";

import { RemoteSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/remote")({
  component: RemoteSettingsPanel,
});
