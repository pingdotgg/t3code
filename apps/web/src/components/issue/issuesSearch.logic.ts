import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { IssuesSearch } from "./IssuesPage";

// The router reads a bare `key=42` as a number.
const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : undefined;
};

const labels = (raw: unknown): ReadonlyArray<string> | undefined => {
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => bounded(name) ?? []);
  return names.length === 0 ? undefined : names.slice(0, 20);
};

// Every optional key is an own key, even when undefined: the router lays these over the parent
// route's unvalidated search, where a key left out would keep its raw value.
export const issuesSearchFromUrl = (raw: Record<string, unknown>): IssuesSearch => ({
  who:
    raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
  status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
  issueServer: bounded(raw.issueServer) as EnvironmentId | undefined,
  issueProject: bounded(raw.issueProject) as ProjectId | undefined,
  host: bounded(raw.host),
  q: bounded(raw.q),
  label: labels(raw.label),
  assignee: bounded(raw.assignee),
  order: raw.order === "created" ? "created" : undefined,
  selectedEnvironmentId: bounded(raw.selectedEnvironmentId) as EnvironmentId | undefined,
  selectedProjectId: bounded(raw.selectedProjectId) as ProjectId | undefined,
  selectedHost: bounded(raw.selectedHost),
  tracker: bounded(raw.tracker),
  scope: bounded(raw.scope),
  key: bounded(raw.key),
});

const distinguishTitles = <Project extends { readonly title: string }>(
  projects: ReadonlyArray<Project>,
  suffix: (project: Project) => string,
) => {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.title, (counts.get(project.title) ?? 0) + 1);
  return projects.map((project) =>
    (counts.get(project.title) ?? 0) > 1
      ? { ...project, title: `${project.title} · ${suffix(project)}` }
      : project,
  );
};

/** One choice per project: projects on one repository can read different Linear teams. */
export const issueFilterProjects = (
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
) => {
  const byServer = distinguishTitles(
    projects.filter((project) => !project.isScratch),
    (project) => environmentLabels.get(project.environmentId) ?? project.environmentId,
  );
  const byPath = distinguishTitles(byServer, (project) => project.workspaceRoot);
  const byEnvironment = distinguishTitles(byPath, (project) => project.environmentId);
  return distinguishTitles(byEnvironment, (project) => project.id).toSorted((left, right) =>
    left.title.localeCompare(right.title),
  );
};
