import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettings";

export const Route = createFileRoute("/_chat/settings/worktrees")({
  component: definePluginRouteRenderer(
    "/settings/worktrees",
    "component",
    definePluginFeature("settings.worktrees", WorktreesSettingsPanel),
  ),
});

registerBuiltinRoute("/settings/worktrees", Route);
