import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";

export const Route = createFileRoute("/_chat/settings/source-control")({
  component: definePluginRouteRenderer(
    "/settings/source-control",
    "component",
    definePluginFeature("settings.source-control", SourceControlSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/source-control", Route);
