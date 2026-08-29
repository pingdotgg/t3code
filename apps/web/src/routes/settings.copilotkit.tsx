import { createFileRoute } from "@tanstack/react-router";

import { CopilotKitSettingsPanel } from "../components/settings/CopilotKitSettings";

export const Route = createFileRoute("/settings/copilotkit")({
  component: CopilotKitSettingsPanel,
});
