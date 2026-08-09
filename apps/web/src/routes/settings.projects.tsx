import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettingsPanel } from "../components/settings/ProjectSettingsPanel";

function SettingsProjectsRoute() {
  return <ProjectSettingsPanel selectedProjectKey={null} />;
}

export const Route = createFileRoute("/settings/projects")({
  component: SettingsProjectsRoute,
});
