import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";

export const Route = createFileRoute("/_chat/settings/projects")({
  component: definePluginRouteRenderer(
    "/settings/projects",
    "component",
    definePluginFeature("settings.projects", ProjectsSettings),
  ),
});

registerBuiltinRoute("/settings/projects", Route);
