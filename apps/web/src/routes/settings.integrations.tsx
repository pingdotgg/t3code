import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettings } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsSettings,
});
