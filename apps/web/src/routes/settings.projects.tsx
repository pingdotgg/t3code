import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";
import { validateSettingsScopeSearch } from "../components/settings/settingsScope";

export const Route = createFileRoute("/settings/projects")({
  validateSearch: validateSettingsScopeSearch,
  component: ProjectsRoute,
});

function ProjectsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectsSettings
      value={search}
      onScopeChange={(scope) => {
        void navigate({
          search: scope,
          replace: true,
        });
      }}
    />
  );
}
