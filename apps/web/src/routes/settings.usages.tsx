import { createFileRoute } from "@tanstack/react-router";

import { UsagesSettingsPanel } from "../components/settings/UsagesSettingsPanel";

function SettingsUsagesRoute() {
  return <UsagesSettingsPanel />;
}

export const Route = createFileRoute("/settings/usages")({
  component: SettingsUsagesRoute,
});
