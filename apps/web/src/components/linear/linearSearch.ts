import type { LinearIssueFilter, LinearPriority } from "@t3tools/contracts";

/** URL-held state of the Linear page; every drill-down step and filter lives here. */
export type LinearGroupBy = "state" | "milestone" | "none";

export interface LinearSearch {
  team?: string;
  project?: string;
  /** A milestone id, or `none` for issues without a milestone. */
  milestone?: string;
  issue?: string;
  q?: string;
  /** Omitted = me. `any` = anyone, otherwise a user id. */
  assignee?: string;
  /** Workflow state ids. Named `states`: `state` already means open/closed on /pull-requests. */
  states?: Array<string>;
  priority?: Array<LinearPriority>;
  /** Label ids. Named `labelIds`: `labels` is a different list on /pull-requests. */
  labelIds?: Array<string>;
  cycle?: string;
  /** A Linear custom view id, or {@link T3_ACTIVITY_VIEW}. */
  view?: string;
  group?: LinearGroupBy;
  showCompleted?: boolean;
}

export type LinearLevel = "workspace" | "team" | "project" | "milestone";

/** T3-only saved view: issues that have at least one linked chat or pipeline run. */
export const T3_ACTIVITY_VIEW = "t3-activity";
export const NO_MILESTONE_ID = "none";
export const LINEAR_ASSIGNEE_ANYONE = "any";
export const DEFAULT_LINEAR_GROUP: LinearGroupBy = "state";

const MAX_LIST_VALUES = 20;
const PRIORITIES: ReadonlyArray<LinearPriority> = [0, 1, 2, 3, 4];

function cleanString(raw: unknown, max = 200): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().slice(0, max);
  return value.length === 0 ? undefined : value;
}

function cleanList(raw: unknown): Array<string> | undefined {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string" || typeof raw === "number"
      ? [raw]
      : [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = cleanString(typeof value === "number" ? String(value) : value);
    if (clean !== undefined) seen.add(clean);
    if (seen.size >= MAX_LIST_VALUES) break;
  }
  return seen.size === 0 ? undefined : [...seen];
}

const SEARCH_KEYS = [
  "team",
  "project",
  "milestone",
  "issue",
  "q",
  "assignee",
  "states",
  "priority",
  "labelIds",
  "cycle",
  "view",
  "group",
  "showCompleted",
] as const satisfies ReadonlyArray<keyof LinearSearch>;

/**
 * Route validator. The parent layout has no validator, so its raw params are merged under the
 * result; every key we own is set explicitly so a hand-edited value cannot leak past parsing.
 */
export function validateLinearRouteSearch(raw: Record<string, unknown>): LinearSearch {
  const parsed = parseLinearSearch(raw);
  return Object.fromEntries(SEARCH_KEYS.map((key) => [key, parsed[key]])) as LinearSearch;
}

/** Validates untrusted router search into a normalized {@link LinearSearch}. */
export function parseLinearSearch(raw: Record<string, unknown>): LinearSearch {
  const priorities = (cleanList(raw.priority) ?? [])
    .map(Number)
    .filter((value): value is LinearPriority => PRIORITIES.includes(value as LinearPriority));
  const states = cleanList(raw.states);
  const labelIds = cleanList(raw.labelIds);
  const group =
    raw.group === "state" || raw.group === "milestone" || raw.group === "none"
      ? raw.group
      : undefined;
  const team = cleanString(raw.team);
  // Deeper levels are meaningless without their parent, so a hand-edited URL cannot strand them.
  const project = team === undefined ? undefined : cleanString(raw.project);
  const milestone = project === undefined ? undefined : cleanString(raw.milestone);
  const assignee = cleanString(raw.assignee);
  return {
    ...(team === undefined ? {} : { team }),
    ...(project === undefined ? {} : { project }),
    ...(milestone === undefined ? {} : { milestone }),
    ...(cleanString(raw.issue) === undefined ? {} : { issue: cleanString(raw.issue)! }),
    ...(cleanString(raw.q) === undefined ? {} : { q: cleanString(raw.q)! }),
    ...(assignee === undefined || assignee === "me" ? {} : { assignee }),
    ...(states === undefined ? {} : { states }),
    ...(priorities.length === 0 ? {} : { priority: [...new Set(priorities)] }),
    ...(labelIds === undefined ? {} : { labelIds }),
    ...(cleanString(raw.cycle) === undefined ? {} : { cycle: cleanString(raw.cycle)! }),
    ...(cleanString(raw.view) === undefined ? {} : { view: cleanString(raw.view)! }),
    ...(group === undefined || group === DEFAULT_LINEAR_GROUP ? {} : { group }),
    ...(raw.showCompleted === true || raw.showCompleted === "true" ? { showCompleted: true } : {}),
  };
}

export function linearLevel(search: LinearSearch): LinearLevel {
  if (search.milestone !== undefined) return "milestone";
  if (search.project !== undefined) return "project";
  if (search.team !== undefined) return "team";
  return "workspace";
}

/** Search keys that belong to the issue list filters, kept while drilling and cleared by "reset". */
const FILTER_KEYS = [
  "q",
  "assignee",
  "states",
  "priority",
  "labelIds",
  "cycle",
  "view",
  "group",
  "showCompleted",
] as const satisfies ReadonlyArray<keyof LinearSearch>;

export function hasActiveLinearFilters(search: LinearSearch): boolean {
  return FILTER_KEYS.some((key) => key !== "group" && search[key] !== undefined);
}

export function clearLinearFilters(search: LinearSearch): LinearSearch {
  const next: LinearSearch = { ...search };
  for (const key of FILTER_KEYS) delete next[key];
  return next;
}

/** Position in the drill-down a link or the "up one level" action leads to. */
export interface LinearScope {
  readonly team?: string | undefined;
  readonly project?: string | undefined;
  readonly milestone?: string | undefined;
}

/**
 * Replaces the drill-down scope while keeping filters (assignee stays when drilling). Filters that
 * name a team's own states, labels or cycles are dropped when the team changes.
 */
export function withLinearScope(search: LinearSearch, scope: LinearScope): LinearSearch {
  const { team: _team, project: _project, milestone: _milestone, issue: _issue, ...rest } = search;
  const teamChanged = scope.team !== search.team;
  const { states: _states, labelIds: _labelIds, cycle: _cycle, ...teamAgnostic } = rest;
  return {
    ...(teamChanged ? teamAgnostic : rest),
    ...(scope.team === undefined ? {} : { team: scope.team }),
    ...(scope.team !== undefined && scope.project !== undefined ? { project: scope.project } : {}),
    ...(scope.team !== undefined && scope.project !== undefined && scope.milestone !== undefined
      ? { milestone: scope.milestone }
      : {}),
  };
}

export function linearParentScope(search: LinearSearch): LinearScope | null {
  switch (linearLevel(search)) {
    case "workspace":
      return null;
    case "team":
      return {};
    case "project":
      return { team: search.team };
    case "milestone":
      return { team: search.team, project: search.project };
  }
}

export interface LinearBreadcrumbNames {
  readonly teamName?: string | undefined;
  readonly projectName?: string | undefined;
  readonly milestoneName?: string | undefined;
}

export interface LinearCrumb {
  readonly label: string;
  readonly scope: LinearScope;
  readonly current: boolean;
}

/** Workspace › Team › Project › Milestone, falling back to ids until names load. */
export function buildLinearBreadcrumb(
  search: LinearSearch,
  names: LinearBreadcrumbNames,
): ReadonlyArray<LinearCrumb> {
  const crumbs: Array<Omit<LinearCrumb, "current">> = [{ label: "Workspace", scope: {} }];
  if (search.team !== undefined) {
    crumbs.push({ label: names.teamName ?? search.team, scope: { team: search.team } });
  }
  if (search.team !== undefined && search.project !== undefined) {
    crumbs.push({
      label: names.projectName ?? search.project,
      scope: { team: search.team, project: search.project },
    });
  }
  if (search.team !== undefined && search.project !== undefined && search.milestone !== undefined) {
    crumbs.push({
      label:
        search.milestone === NO_MILESTONE_ID
          ? "No milestone"
          : (names.milestoneName ?? search.milestone),
      scope: { team: search.team, project: search.project, milestone: search.milestone },
    });
  }
  return crumbs.map((crumb, index) => ({ ...crumb, current: index === crumbs.length - 1 }));
}

export interface LinearFilterContext {
  /** Issue ids with T3 activity; required for the "Has T3 activity" view. */
  readonly activityIssueIds: ReadonlyArray<string>;
}

/** Maps the page's URL state to the server's issue filter. */
export function linearIssueFilter(
  search: LinearSearch,
  context: LinearFilterContext,
): LinearIssueFilter {
  const t3View = search.view === T3_ACTIVITY_VIEW;
  const customView = search.view !== undefined && !t3View ? search.view : undefined;
  const assignee = search.assignee ?? "me";
  return {
    ...(search.team === undefined ? {} : { teamId: search.team }),
    ...(search.project === undefined ? {} : { projectId: search.project }),
    ...(search.milestone === undefined ? {} : { milestoneId: search.milestone }),
    // A custom view carries its own filter; the other controls would fight it.
    ...(customView === undefined
      ? {
          ...(assignee === LINEAR_ASSIGNEE_ANYONE ? {} : { assignee }),
          ...(search.states === undefined ? {} : { stateIds: search.states }),
          ...(search.priority === undefined ? {} : { priorities: search.priority }),
          ...(search.labelIds === undefined ? {} : { labelIds: search.labelIds }),
          ...(search.cycle === undefined ? {} : { cycleId: search.cycle }),
        }
      : { viewId: customView }),
    ...(search.q === undefined ? {} : { text: search.q }),
    ...(search.showCompleted === true ? { includeCompleted: true } : {}),
    ...(t3View ? { issueIds: context.activityIssueIds } : {}),
  };
}

export type LinearSearchPatch = { [K in keyof LinearSearch]?: LinearSearch[K] | undefined };

/** Merges a patch into the search; `undefined` values remove their key from the URL. */
export function patchLinearSearch(search: LinearSearch, patch: LinearSearchPatch): LinearSearch {
  const next: Record<string, unknown> = { ...search };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as LinearSearch;
}

/** `https://linear.app/<org>/team/<KEY>/new` inside a team, else the workspace-level new issue. */
export function buildLinearNewIssueUrl(
  organizationUrlKey: string | null,
  teamKey: string | undefined,
): string | null {
  if (organizationUrlKey === null) return null;
  const base = `https://linear.app/${encodeURIComponent(organizationUrlKey)}`;
  return teamKey === undefined ? `${base}/new` : `${base}/team/${encodeURIComponent(teamKey)}/new`;
}
