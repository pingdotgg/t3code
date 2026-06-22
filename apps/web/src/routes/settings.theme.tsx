import { createFileRoute } from "@tanstack/react-router";

import { ThemeSettingsPanel } from "../components/settings/ThemeSettingsPanel";

function SettingsThemeRoute() {
  return <ThemeSettingsPanel />;
}

export const Route = createFileRoute("/settings/theme")({
  component: SettingsThemeRoute,
});
