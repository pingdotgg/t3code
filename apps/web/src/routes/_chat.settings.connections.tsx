import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsConnectionsRoute() {
  return <ConnectionsSettings view="environments" />;
}

export const Route = createFileRoute("/_chat/settings/connections")({
  component: definePluginRouteRenderer(
    "/settings/connections",
    "component",
    definePluginFeature("settings.connections", SettingsConnectionsRoute),
  ),
});

registerBuiltinRoute("/settings/connections", Route);
