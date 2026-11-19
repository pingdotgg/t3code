import { useAtomValue } from "@effect/atom-react";

import { environmentProjects } from "../state/projects";

export function ProjectList() {
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const visible = projects.filter((project) => project.archivedAt == null);
  if (visible.length === 0) return <p className="px-2 py-1 text-faint">No projects yet</p>;
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {visible.map((project) => (
        <li
          key={`${project.environmentId}:${project.id}`}
          className="truncate rounded-md px-2 py-1 text-fg hover:bg-hover"
        >
          {project.title}
        </li>
      ))}
    </ul>
  );
}
