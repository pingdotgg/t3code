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
 * the fewest trailing folders of their paths. The scratch project leads, beside All projects.
 */
export const issueFilterProjects = (
  projects: ReadonlyArray<EnvironmentProject>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
) => {
  const named = projects.filter((project) => !project.isScratch);
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
