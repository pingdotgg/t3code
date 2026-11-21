import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsAccessRoute() {
  return <ConnectionsSettings view="access" />;
}

export const Route = createFileRoute("/_chat/settings/access")({
  component: definePluginRouteRenderer(
    "/settings/access",
    "component",
    definePluginFeature("settings.access", SettingsAccessRoute),
  ),
});

registerBuiltinRoute("/settings/access", Route);
