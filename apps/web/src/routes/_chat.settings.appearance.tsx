import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";

function SettingsAppearanceRoute() {
  return <AppearanceSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/appearance")({
  component: definePluginRouteRenderer(
    "/settings/appearance",
    "component",
    definePluginFeature("settings.appearance", SettingsAppearanceRoute),
  ),
});

registerBuiltinRoute("/settings/appearance", Route);
