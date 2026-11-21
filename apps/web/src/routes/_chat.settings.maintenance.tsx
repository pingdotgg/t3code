import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { MaintenanceSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/maintenance")({
  component: definePluginRouteRenderer(
    "/settings/maintenance",
    "component",
    definePluginFeature("settings.maintenance", MaintenanceSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/maintenance", Route);
