import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "../components/projects/ProjectsPage";

export const Route = createFileRoute("/_chat/projects")({
  validateSearch: (raw: Record<string, unknown>): { project?: string } =>
    typeof raw.project === "string" && raw.project ? { project: raw.project.slice(0, 512) } : {},
  component: ProjectsPage,
});
