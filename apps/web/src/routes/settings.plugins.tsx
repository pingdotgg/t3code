import { createFileRoute } from "@tanstack/react-router";

import { PluginMarketplace } from "../components/settings/pluginMarketplace/PluginMarketplace";

export const Route = createFileRoute("/settings/plugins")({
  component: PluginMarketplace,
});
