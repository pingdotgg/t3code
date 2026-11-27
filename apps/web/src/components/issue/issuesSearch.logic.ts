import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  ISSUE_LIST_MAX_EXCLUDED_PROJECTS,
  type EnvironmentId,
  type IssueListInput,
  type ProjectId,
} from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

import type { IssueListTarget } from "@t3tools/client-runtime/state/issues";

import type { IssuesSearch } from "./IssuesPage";

// The router reads a bare `key=42` as a number.
const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? trimmed.slice(0, splitsSurrogatePair(trimmed, 200) ? 199 : 200) : undefined;
};

const labels = (raw: unknown): ReadonlyArray<string> | undefined => {
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => bounded(name) ?? []);
  return names.length === 0 ? undefined : names.slice(0, 20);
};

const projectPairs = (raw: unknown): IssuesSearch["hideProjects"] => {
  const pairs = (Array.isArray(raw) ? raw : []).flatMap((pair) => {
    const environmentId = Array.isArray(pair) ? bounded(pair[0]) : undefined;
    const projectId = Array.isArray(pair) ? bounded(pair[1]) : undefined;
    return environmentId && projectId
      ? [[environmentId as EnvironmentId, projectId as ProjectId] as const]
      : [];
  });
  return pairs.length === 0 ? undefined : pairs.slice(0, ISSUE_LIST_MAX_EXCLUDED_PROJECTS);
};

// Every optional key is an own key, even when undefined: the router lays these over the parent
// route's unvalidated search, where a key left out would keep its raw value.
export const issuesSearchFromUrl = (raw: Record<string, unknown>): IssuesSearch => ({
  who:
    raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
  status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
  hideProjects: projectPairs(raw.hideProjects),
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

type Labeled<Project> = Project & {
  readonly label: string;
  readonly details: ReadonlyArray<string>;
};

const distinguish = <Project>(
  projects: ReadonlyArray<Labeled<Project>>,
  detail: (project: Project) => string,
): ReadonlyArray<Labeled<Project>> => {
  const counts = new Map<string, number>();
  const key = (project: Labeled<Project>) => JSON.stringify([project.label, project.details]);
  for (const project of projects) counts.set(key(project), (counts.get(key(project)) ?? 0) + 1);
  return projects.map((project) =>
    (counts.get(key(project)) ?? 0) > 1
      ? { ...project, details: [...project.details, detail(project)] }
      : project,
  );
};

/**
 * One choice per project: projects on one repository can read different Linear teams. Scratch
 * projects stay, since Settings can bind one to a Linear team.
 */
export const issueFilterProjects = (
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
) => {
  const labeled = projects.map((project) => ({
    ...project,
    label: project.title,
    details: [] as string[],
  }));
  const byServer = distinguish(
    labeled,
    (project) => environmentLabels.get(project.environmentId) ?? project.environmentId,
  );
  const byPath = distinguish(byServer, (project) => project.workspaceRoot);
  const byEnvironment = distinguish(byPath, (project) => project.environmentId);
  return distinguish(byEnvironment, (project) => project.id)
    .map(({ label, details, ...project }) => ({
      ...project,
      title: details.length === 0 ? label : `${label} (${details.join(", ")})`,
    }))
    .toSorted((left, right) => left.title.localeCompare(right.title));
};

/** The same key as `pullRequestProjectKey`. */
const projectKey = (project: { readonly id: ProjectId; readonly environmentId: EnvironmentId }) =>
  JSON.stringify([project.environmentId, project.id]);

export const issueProjectKeys = (pairs: IssuesSearch["hideProjects"]): ReadonlySet<string> =>
  new Set((pairs ?? []).map((pair) => JSON.stringify(pair)));

/**
 * Each environment leaves out its hidden projects, named from the saved pairs so a listing sent
 * before the project list loads still leaves them out. One with every project hidden is not read.
 * Rows past the request limit are hidden on the client.
 */
export function issueListTargets(
  environmentIds: ReadonlyArray<EnvironmentId>,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly environmentId: EnvironmentId }>,
  hidden: IssuesSearch["hideProjects"],
  input: IssueListInput,
): ReadonlyArray<IssueListTarget> {
  const keys = issueProjectKeys(hidden);
  return environmentIds.flatMap((environmentId) => {
    const own = projects.filter((project) => project.environmentId === environmentId);
    if (own.length > 0 && own.every((project) => keys.has(projectKey(project)))) return [];
    const excludeProjectIds = (
      own.length > 0
        ? own.filter((project) => keys.has(projectKey(project))).map((project) => project.id)
        : (hidden ?? [])
            .filter(([environment]) => environment === environmentId)
            .map(([, projectId]) => projectId)
    ).slice(0, ISSUE_LIST_MAX_EXCLUDED_PROJECTS);
    return [
      {
        environmentId,
        input: excludeProjectIds.length ? { ...input, excludeProjectIds } : input,
      },
    ];
  });
}
