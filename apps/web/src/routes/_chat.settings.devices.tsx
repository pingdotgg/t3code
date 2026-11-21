import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { DevicesSettingsPanel } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/_chat/settings/devices")({
  component: definePluginRouteRenderer(
    "/settings/devices",
    "component",
    definePluginFeature("settings.devices", DevicesSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/devices", Route);
