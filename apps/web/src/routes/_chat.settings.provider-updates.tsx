import { createFileRoute } from "@tanstack/react-router";

import { ProviderUpdatesSettingsPanel } from "../components/settings/ProviderUpdatesSettingsPanel";

export const Route = createFileRoute("/_chat/settings/provider-updates")({
  component: ProviderUpdatesSettingsPanel,
});
