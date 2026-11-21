import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { PluginsSettingsPanel } from "../components/settings/PluginsSettings";

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: definePluginRouteRenderer("/settings/plugins", "component", PluginsSettingsPanel),
});

registerBuiltinRoute("/settings/plugins", Route);
