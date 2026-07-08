import { createFileRoute } from "@tanstack/react-router";

import { AgentWorkflowsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/workflows")({
  component: AgentWorkflowsSettingsPanel,
});
