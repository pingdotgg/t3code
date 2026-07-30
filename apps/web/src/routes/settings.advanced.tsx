import { createFileRoute } from "@tanstack/react-router";

import { AdvancedSettingsPanel } from "../components/settings/AdvancedSettingsPanel";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSettingsPanel,
});
