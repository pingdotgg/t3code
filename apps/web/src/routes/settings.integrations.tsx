import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettingsPanel,
});
