import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { DiffsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/diffs")({
  component: definePluginRouteRenderer(
    "/settings/diffs",
    "component",
    definePluginFeature("settings.diffs", DiffsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/diffs", Route);
