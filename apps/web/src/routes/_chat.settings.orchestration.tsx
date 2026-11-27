import { createFileRoute } from "@tanstack/react-router";

import { OrchestrationSettingsPanel } from "../components/settings/OrchestrationSettings";

export const Route = createFileRoute("/_chat/settings/orchestration")({
  component: OrchestrationSettingsPanel,
});
