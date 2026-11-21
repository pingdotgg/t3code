import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { ThreadsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/threads")({
  component: definePluginRouteRenderer(
    "/settings/threads",
    "component",
    definePluginFeature("settings.threads", ThreadsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/threads", Route);
