import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";

export const Route = createFileRoute("/settings/projects")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
    machine: typeof search.machine === "string" ? search.machine : undefined,
  }),
  component: ProjectsRoute,
});

function ProjectsRoute() {
  const { project, machine } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectsSettings
      projectKey={project ?? null}
      machineId={machine ?? null}
      onScopeChange={(project, machine) => {
        void navigate({
          search: { project: project ?? undefined, machine: machine ?? undefined },
          replace: true,
        });
      }}
    />
  );
}
