import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { ArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";

export const Route = createFileRoute("/_chat/settings/archived")({
  component: definePluginRouteRenderer(
    "/settings/archived",
    "component",
    definePluginFeature("settings.archived", ArchivedThreadsPanel),
  ),
});

registerBuiltinRoute("/settings/archived", Route);
