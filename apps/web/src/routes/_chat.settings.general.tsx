import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsGeneralRoute() {
  return <GeneralSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/general")({
  component: definePluginRouteRenderer(
    "/settings/general",
    "component",
    definePluginFeature("settings.general", SettingsGeneralRoute),
  ),
});

registerBuiltinRoute("/settings/general", Route);
