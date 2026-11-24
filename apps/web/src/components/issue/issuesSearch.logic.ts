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

const SEGMENT_LIMIT = 14;

const groupBy = <Item, Key>(items: ReadonlyArray<Item>, key: (item: Item) => Key) => {
  const groups = new Map<Key, Item[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};

const pathSegments = (path: string) => path.split(/[\\/]+/).filter(Boolean);
const shortSegment = (segment: string) =>
  segment.length > SEGMENT_LIMIT ? `${segment.slice(0, SEGMENT_LIMIT - 1)}…` : segment;

/** The fewest trailing folders of each path that tell them all apart, shortened. */
const pathSuffixes = (paths: ReadonlyArray<string>): ReadonlyArray<string> | null => {
  const segments = paths.map(pathSegments);
  const longest = Math.max(0, ...segments.map((parts) => parts.length));
  for (let count = 1; count <= longest; count++) {
    const suffixes = segments.map((parts) => {
      const shown = parts.slice(-count).map(shortSegment).join("/");
      return parts.length > count ? `…/${shown}` : shown;
    });
    if (new Set(suffixes).size === suffixes.length) return suffixes;
  }
  return null;
};

/**
 * One choice per project: projects on one repository can read different Linear teams. Projects
 * that share a name say the least that tells them apart: the machine where that differs, then
 * the fewest trailing folders of their paths. The scratch project leads, beside All projects;
 * scratch projects stay, since Settings can bind one to a Linear team.
 */
export const issueFilterProjects = (
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
) => {
  const named = projects;
  const byTitle = groupBy(named, (project) => project.title);
  const details = new Map<EnvironmentProject, string>();
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    const machines = same.map(
      (project) => environmentLabels.get(project.environmentId) ?? project.environmentId,
    );
    const machinesDiffer = new Set(machines).size > 1;
    // Within one machine, the path tells the projects apart.
    const byMachine = groupBy(same, (project) => project.environmentId);
    for (const group of byMachine.values()) {
      const suffixes = group.length > 1 ? pathSuffixes(group.map((p) => p.workspaceRoot)) : null;
      group.forEach((project, index) => {
        const parts = [
          ...(machinesDiffer
            ? [environmentLabels.get(project.environmentId) ?? project.environmentId]
            : []),
          ...(group.length > 1 ? [suffixes?.[index] ?? project.id] : []),
        ];
        if (parts.length > 0) details.set(project, parts.join(", "));
      });
    }
  }
  const scratchFirst = (project: EnvironmentProject) =>
    project.repositoryIdentity == null && project.title === "No project" ? 0 : 1;
  return named
    .map((project) => {
      const detail = details.get(project);
      return { ...project, title: detail ? `${project.title} (${detail})` : project.title };
    })
    .toSorted(
      (left, right) =>
        scratchFirst(left) - scratchFirst(right) || left.title.localeCompare(right.title),
    );
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
