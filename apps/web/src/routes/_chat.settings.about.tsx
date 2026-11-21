import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { AboutSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/about")({
  component: definePluginRouteRenderer(
    "/settings/about",
    "component",
    definePluginFeature("settings.about", AboutSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/about", Route);
