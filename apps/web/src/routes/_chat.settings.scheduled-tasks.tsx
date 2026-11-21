import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

import { SettingsScheduledTasksRoute } from "../components/settings/SettingsScheduledTasksPage";

export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: definePluginRouteRenderer(
    "/settings/scheduled-tasks",
    "component",
    definePluginFeature("settings.scheduled-tasks", SettingsScheduledTasksRoute),
  ),
});

registerBuiltinRoute("/settings/scheduled-tasks", Route);
