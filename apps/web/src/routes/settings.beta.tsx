import { createFileRoute } from "@tanstack/react-router";

import { BetaSettingsPanel } from "../components/settings/BetaSettingsPanel";

function SettingsBetaRoute() {
  return <BetaSettingsPanel />;
}

export const Route = createFileRoute("/settings/beta")({
  component: SettingsBetaRoute,
});
