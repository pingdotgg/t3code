import { createFileRoute } from "@tanstack/react-router";

import { SystemPromptSettingsPanel } from "../components/settings/SystemPromptSettings";

export const Route = createFileRoute("/settings/prompt")({
  component: SystemPromptSettingsPanel,
});
