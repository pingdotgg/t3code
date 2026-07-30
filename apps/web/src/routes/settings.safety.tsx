import { createFileRoute } from "@tanstack/react-router";

import { SafetySettingsPanel } from "../components/settings/SafetySettingsPanel";

export const Route = createFileRoute("/settings/safety")({
  component: SafetySettingsPanel,
});
