import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { SnapShotSettings } from "../components/settings/SnapShotSettings";

function SettingsSnapShotRoute() {
  return <SnapShotSettings />;
}

export const Route = createFileRoute("/_chat/settings/snap-shot")({
  component: definePluginRouteRenderer(
    "/settings/snap-shot",
    "component",
    definePluginFeature("settings.snap-shot", SettingsSnapShotRoute),
  ),
});

registerBuiltinRoute("/settings/snap-shot", Route);
