import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";

function SettingsIntegrationsRoute() {
  return <IntegrationsSettingsPanel />;
}

export const Route = createFileRoute("/settings/integrations")({
  component: SettingsIntegrationsRoute,
});
