import { ISSUE_LIST_PROJECT_LIMIT, type EnvironmentId, type ProjectId } from "@t3tools/contracts";

import type { IssuesSearch } from "./IssuesPage";

// The router reads a bare `key=42` as a number.
const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : undefined;
};

const names = (raw: unknown, max: number): ReadonlyArray<string> | undefined => {
  const found = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => bounded(name) ?? []);
  return found.length === 0 ? undefined : found.slice(0, max);
};

// Every optional key is an own key, even when undefined: the router lays these over the parent
// route's unvalidated search, where a key left out would keep its raw value.
export const issuesSearchFromUrl = (raw: Record<string, unknown>): IssuesSearch => ({
  who:
    raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
  status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
  host: bounded(raw.host),
  q: bounded(raw.q),
  label: names(raw.label, 20),
  assignee: bounded(raw.assignee),
  order: raw.order === "created" ? "created" : undefined,
  project: names(raw.project, ISSUE_LIST_PROJECT_LIMIT),
  selectedEnvironmentId: bounded(raw.selectedEnvironmentId) as EnvironmentId | undefined,
  selectedProjectId: bounded(raw.selectedProjectId) as ProjectId | undefined,
  selectedHost: bounded(raw.selectedHost),
  tracker: bounded(raw.tracker),
  scope: bounded(raw.scope),
  key: bounded(raw.key),
});
