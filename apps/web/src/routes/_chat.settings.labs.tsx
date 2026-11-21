import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { LabsSettingsPanel } from "../components/settings/LabsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/labs")({
  component: definePluginRouteRenderer(
    "/settings/labs",
    "component",
    definePluginFeature("settings.labs", LabsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/labs", Route);
