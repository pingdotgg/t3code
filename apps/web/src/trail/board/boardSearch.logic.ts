import type { EnvironmentId, IssueListState, ProjectId } from "@t3tools/contracts";

export type BoardSearch = {
  readonly status: IssueListState;
  readonly label?: ReadonlyArray<string> | undefined;
  readonly host?: string | undefined;
  readonly selectedEnvironmentId?: EnvironmentId | undefined;
  readonly selectedProjectId?: ProjectId | undefined;
  readonly selectedHost?: string | undefined;
  readonly tracker?: string | undefined;
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
};

const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : undefined;
};

const labels = (raw: unknown): ReadonlyArray<string> | undefined => {
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => bounded(name) ?? []);
  return names.length === 0 ? undefined : names.slice(0, 20);
};

/** Router search for `/board`. Every optional key is own so raw parent values do not leak. */
export const boardSearchFromUrl = (raw: Record<string, unknown>): BoardSearch => ({
  status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
  label: labels(raw.label),
  host: bounded(raw.host),
  selectedEnvironmentId: bounded(raw.selectedEnvironmentId) as EnvironmentId | undefined,
  selectedProjectId: bounded(raw.selectedProjectId) as ProjectId | undefined,
  selectedHost: bounded(raw.selectedHost),
  tracker: bounded(raw.tracker),
  scope: bounded(raw.scope),
  key: bounded(raw.key),
});
