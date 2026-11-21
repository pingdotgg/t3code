import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";

export const Route = createFileRoute("/_chat/settings/keybindings")({
  component: definePluginRouteRenderer(
    "/settings/keybindings",
    "component",
    definePluginFeature("settings.keybindings", KeybindingsSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/keybindings", Route);
