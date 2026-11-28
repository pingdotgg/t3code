import { pullRequestFilterProjects } from "@t3tools/client-runtime/pull-request-project-filter";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  ISSUE_LIST_MAX_EXCLUDED_PROJECTS,
  repositoryGroupingKeyOf,
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

/** The same key as `pullRequestProjectKey`. */
const projectKey = (project: { readonly id: ProjectId; readonly environmentId: EnvironmentId }) =>
  JSON.stringify([project.environmentId, project.id]);

/** One filter entry: a repository across environments, or a single project without one. */
export interface IssueFilterProject extends EnvironmentProject {
  /** `pullRequestProjectKey` of every member: hiding the entry hides them all. */
  readonly memberProjectKeys: ReadonlyArray<string>;
}

/**
 * One choice per repository across environments and checkouts: hiding it hides the repository
 * everywhere, so projects on one repository bound to different Linear teams hide together.
 * Scratch projects stay their own choice, since Settings can bind one to a Linear team.
 */
export const issueFilterProjects = (
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
): ReadonlyArray<IssueFilterProject> => {
  const groups = new Map<string, { project: EnvironmentProject; memberProjectKeys: string[] }>();
  for (const project of projects) {
    const repository =
      project.isScratch !== true && project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()
        : undefined;
    const key = JSON.stringify(repository ?? [project.environmentId, project.id]);
    const group = groups.get(key);
    if (group) group.memberProjectKeys.push(projectKey(project));
    else groups.set(key, { project, memberProjectKeys: [projectKey(project)] });
  }
  return pullRequestFilterProjects(
    [...groups.values()].map(({ project, memberProjectKeys }) => ({
      ...project,
      // Grouped already; the shared helper would split the group again per environment.
      repositoryIdentity: null,
      memberProjectKeys,
    })),
    environmentLabels,
  );
};

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
