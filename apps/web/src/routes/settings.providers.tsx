import { createFileRoute } from "@tanstack/react-router";

import { ProvidersSettingsPanel } from "../components/settings/ProvidersSettings";

export const Route = createFileRoute("/settings/providers")({
  component: ProvidersSettingsPanel,
});
