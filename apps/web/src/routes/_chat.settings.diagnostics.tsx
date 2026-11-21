import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";

export const Route = createFileRoute("/_chat/settings/diagnostics")({
  component: definePluginRouteRenderer(
    "/settings/diagnostics",
    "component",
    definePluginFeature("settings.diagnostics", DiagnosticsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/diagnostics", Route);
