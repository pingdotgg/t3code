import { createFileRoute } from "@tanstack/react-router";

import { InterfaceSettingsPanel } from "../components/settings/InterfaceSettingsPanel";

function SettingsInterfaceRoute() {
  return <InterfaceSettingsPanel />;
}

export const Route = createFileRoute("/settings/interface")({
  component: SettingsInterfaceRoute,
});
