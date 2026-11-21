import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { ChatSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/chat")({
  component: definePluginRouteRenderer(
    "/settings/chat",
    "component",
    definePluginFeature("settings.chat", ChatSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/chat", Route);
