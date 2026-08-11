import { createFileRoute } from "@tanstack/react-router";

import { AgentsSettingsPanel } from "../components/settings/AgentsSettings";

function SettingsAgentsRoute() {
  return <AgentsSettingsPanel />;
}

export const Route = createFileRoute("/settings/agents")({
  component: SettingsAgentsRoute,
});
