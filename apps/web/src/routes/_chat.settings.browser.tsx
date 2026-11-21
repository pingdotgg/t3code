import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { BrowserSettingsPanel } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/_chat/settings/browser")({
  component: definePluginRouteRenderer(
    "/settings/browser",
    "component",
    definePluginFeature("settings.browser", BrowserSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/browser", Route);
