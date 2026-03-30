import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPanel,
});
