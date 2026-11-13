import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";

export const Route = createFileRoute("/_chat/settings/diagnostics")({
  component: DiagnosticsSettingsPanel,
});
