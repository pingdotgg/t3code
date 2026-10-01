import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettings";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPanel,
});
