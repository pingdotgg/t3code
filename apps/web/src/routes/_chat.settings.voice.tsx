import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";

export const Route = createFileRoute("/_chat/settings/voice")({
  component: definePluginRouteRenderer(
    "/settings/voice",
    "component",
    definePluginFeature("settings.voice", VoiceSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/voice", Route);
