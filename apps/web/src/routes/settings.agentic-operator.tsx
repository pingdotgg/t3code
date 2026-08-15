import { createFileRoute } from "@tanstack/react-router";

import { AgenticOperatorSettingsPanel } from "../components/settings/AgenticOperatorSettingsPanel";

function SettingsAgenticOperatorRoute() {
  return <AgenticOperatorSettingsPanel />;
}

export const Route = createFileRoute("/settings/agentic-operator")({
  component: SettingsAgenticOperatorRoute,
});
