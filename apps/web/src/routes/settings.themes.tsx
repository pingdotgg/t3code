import { createFileRoute } from "@tanstack/react-router";

import { ThemesPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/themes")({
  component: ThemesPanel,
});
