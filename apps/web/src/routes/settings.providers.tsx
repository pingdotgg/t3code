import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

function SettingsProvidersRoute() {
  return <ProviderSettingsPanel />;
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRoute,
});
