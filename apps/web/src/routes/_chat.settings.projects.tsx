import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";

export const Route = createFileRoute("/_chat/settings/projects")({
  component: ProjectsSettings,
});
