import { pullRequestFilterProjects } from "@t3tools/client-runtime/pull-request-project-filter";
import { parsePullRequestQuery } from "@t3tools/client-runtime/pull-request-query";
import {
  buildProjectGroups,
  type ProjectGroup,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ProjectId,
  resolvePullRequestAuthorFilter,
  type EnvironmentId,
  type PullRequestDiffStat,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { PullRequestListControls } from "../../persistence/mobile-preferences";

export const PR_LIST_PAGE_SIZE = 30;
export type { PullRequestListControls } from "../../persistence/mobile-preferences";
export const DEFAULT_PR_LIST_CONTROLS: PullRequestListControls = {
  state: "open",
  involvement: "all",
  filters: {},
  sort: "updated",
};

export function pullRequestProjectGroups(projects: readonly EnvironmentProject[]) {
  const groups = buildProjectGroups({
    projects: projects.filter((project) => !project.isScratch),
    settings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
  });
  const labelCounts = new Map<string, number>();
  for (const group of groups) {
    labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1);
  }
  return groups.map((group) =>
    labelCounts.get(group.label)! > 1
      ? { ...group, label: `${group.label} · ${group.key}` }
      : group,
  );
}

export function findPullRequestProjectGroup(
  groups: readonly ProjectGroup[],
  controls: PullRequestListControls,
) {
  return groups.find((group) =>
    group.memberProjectRefs.some(
      (ref) =>
        ref.projectId === controls.projectId && ref.environmentId === controls.projectEnvironmentId,
    ),
  );
}

export function withoutScratchProjectScope(
  controls: PullRequestListControls,
  projects: readonly { id: string; environmentId: string; isScratch?: true }[],
): PullRequestListControls {
  return projects.some(
    (project) =>
      project.isScratch &&
      project.id === controls.projectId &&
      project.environmentId === controls.projectEnvironmentId,
  )
    ? { ...controls, projectId: undefined, projectEnvironmentId: undefined }
    : controls;
}

type FilterProject = Parameters<typeof pullRequestFilterProjects>[0][number];

export function pullRequestProjectChoices<
  Project extends FilterProject & { readonly isScratch?: true },
>(
  projects: readonly Project[],
  input: {
    readonly environmentId: string | null;
    readonly controls: PullRequestListControls;
    readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
    readonly servesPullRequests: (environmentId: EnvironmentId) => boolean;
  },
) {
  return pullRequestFilterProjects(
    eligiblePullRequestProjects(projects, input),
    input.environmentLabels,
    projects.find(
      (project) =>
        project.id === input.controls.projectId &&
        project.environmentId === input.controls.projectEnvironmentId,
    ),
  );
}

export function eligiblePullRequestProjects<
  Project extends FilterProject & { readonly isScratch?: true },
>(
  projects: readonly Project[],
  input: {
    readonly environmentId: string | null;
    readonly controls: PullRequestListControls;
    readonly servesPullRequests: (environmentId: EnvironmentId) => boolean;
  },
) {
  return projects.filter(
    (project) =>
      !project.isScratch &&
      (input.environmentId === null || project.environmentId === input.environmentId) &&
      (input.servesPullRequests(project.environmentId) ||
        (project.id === input.controls.projectId &&
          project.environmentId === input.controls.projectEnvironmentId)),
  );
}

export function pullRequestListKey(
  item: Pick<PullRequestListEntry, "host" | "repository" | "number">,
) {
  return `${item.host.toLowerCase()}:${item.repository.toLowerCase()}:${item.number}`;
}

export type EnvironmentPullRequestListEntry = PullRequestListEntry & {
  readonly environmentId: EnvironmentId;
};

export const scopedPullRequestListKey = (entry: EnvironmentPullRequestListEntry) =>
  `${entry.environmentId}:${pullRequestListKey(entry)}`;

export const pullRequestStatKey = (
  row: Pick<PullRequestDiffStat, "projectId" | "repository" | "number">,
) => `${row.projectId}:${row.repository}:${row.number}`;

/**
 * Diff stats an environment has answered, the stats query that answered each, and each row's
 * `updatedAt` as its list last answered it.
 */
export interface PullRequestStatsCache {
  readonly stats: ReadonlyMap<string, PullRequestDiffStat>;
  readonly answeredBy: ReadonlyMap<string, PullRequestListStatsInput>;
  readonly updatedAt: ReadonlyMap<string, string>;
}

export const EMPTY_PULL_REQUEST_STATS_CACHE: PullRequestStatsCache = {
  stats: new Map(),
  answeredBy: new Map(),
  updatedAt: new Map(),
};

/**
 * Records the rows a list answered. Stats carry no head, so a row whose `updatedAt` moved (a push,
 * among other changes) drops its cached stat, and the stats queries that answered it are returned
 * to refresh: one can still be fresh and would otherwise answer the row's next read with the old
 * counts.
 */
export function withListedPullRequests(
  cache: PullRequestStatsCache,
  entries: readonly Pick<
    PullRequestListEntry,
    "projectId" | "repository" | "number" | "updatedAt"
  >[],
): {
  readonly cache: PullRequestStatsCache;
  readonly refresh: readonly PullRequestListStatsInput[];
} {
  const moved = entries.filter(
    (entry) => cache.updatedAt.get(pullRequestStatKey(entry)) !== entry.updatedAt,
  );
  if (!moved.length) return { cache, refresh: [] };
  const stats = new Map(cache.stats);
  const answeredBy = new Map(cache.answeredBy);
  const updatedAt = new Map(cache.updatedAt);
  const refresh = new Set<PullRequestListStatsInput>();
  for (const entry of moved) {
    const key = pullRequestStatKey(entry);
    const query = answeredBy.get(key);
    if (query) refresh.add(query);
    stats.delete(key);
    answeredBy.delete(key);
    updatedAt.set(key, entry.updatedAt);
  }
  return { cache: { stats, answeredBy, updatedAt }, refresh: [...refresh] };
}

export function withAnsweredPullRequestStats(
  cache: PullRequestStatsCache,
  input: PullRequestListStatsInput,
  answered: readonly PullRequestDiffStat[],
): PullRequestStatsCache {
  const stats = new Map(cache.stats);
  const answeredBy = new Map(cache.answeredBy);
  for (const row of answered) {
    stats.set(pullRequestStatKey(row), row);
    answeredBy.set(pullRequestStatKey(row), input);
  }
  return { ...cache, stats, answeredBy };
}

/**
 * Fills rows that have no diff stat yet from the stats answers on screen. Returns `entries`
 * itself when no row changes, so the list keeps its identity across renders.
 */
export function withShownPullRequestStats(
  entries: readonly EnvironmentPullRequestListEntry[],
  answers: readonly {
    readonly environmentId: EnvironmentId;
    readonly stats: readonly PullRequestDiffStat[];
  }[],
): readonly EnvironmentPullRequestListEntry[] {
  const shown = new Map(
    answers.flatMap(({ environmentId, stats }) =>
      stats.map((row) => [`${environmentId}:${pullRequestStatKey(row)}`, row] as const),
    ),
  );
  if (!shown.size) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const stat = shown.get(`${entry.environmentId}:${pullRequestStatKey(entry)}`);
    if (!stat || entry.additions + entry.deletions !== 0) return entry;
    if (stat.additions + stat.deletions === 0) return entry;
    changed = true;
    return { ...entry, additions: stat.additions, deletions: stat.deletions };
  });
  return changed ? next : entries;
}

export function pullRequestListRowsAreEqual(
  previous: EnvironmentPullRequestListEntry,
  next: EnvironmentPullRequestListEntry,
) {
  return (
    previous === next ||
    (previous.environmentId === next.environmentId &&
      previous.projectId === next.projectId &&
      previous.host === next.host &&
      previous.repository === next.repository &&
      previous.number === next.number &&
      previous.title === next.title &&
      previous.url === next.url &&
      previous.state === next.state &&
      previous.isDraft === next.isDraft &&
      previous.mergeability === next.mergeability &&
      previous.baseBranch === next.baseBranch &&
      previous.updatedAt === next.updatedAt &&
      previous.additions === next.additions &&
      previous.deletions === next.deletions &&
      previous.checksState === next.checksState &&
      previous.reviewDecision === next.reviewDecision &&
      previous.viewerReviewRequested === next.viewerReviewRequested &&
      previous.author?.login === next.author?.login &&
      previous.author?.avatarUrl === next.author?.avatarUrl &&
      previous.stack?.position === next.stack?.position &&
      previous.stack?.size === next.stack?.size &&
      previous.labels.length === next.labels.length &&
      previous.labels.every(
        (label, index) =>
          label.name === next.labels[index]?.name && label.color === next.labels[index]?.color,
      ))
  );
}

export function mergeEnvironmentPullRequestPages(
  sources: readonly { environmentId: EnvironmentId; pages: PullRequestListPages }[],
) {
  const viewers: Record<string, string> = {};
  const localSearchHosts = new Set<string>();
  const entries: EnvironmentPullRequestListEntry[] = [];
  const errors = [];
  for (const { environmentId, pages } of sources) {
    entries.push(...pages.entries.map((entry) => ({ ...entry, environmentId })));
    for (const [host, viewer] of Object.entries(pages.head.viewers))
      viewers[`${environmentId} ${host}`] = viewer;
    for (const provider of pages.head.providers)
      if (!provider.searchesOnHost) localSearchHosts.add(`${environmentId} ${provider.host}`);
    errors.push(...pages.head.errors.map((error) => ({ ...error, environmentId })));
  }
  return {
    entries,
    viewers,
    localSearchHosts,
    errors,
    continued: sources.some(({ pages }) => pages.continued),
  };
}

export function mergePullRequestListEntries(
  previous: readonly PullRequestListEntry[],
  incoming: readonly PullRequestListEntry[],
) {
  const entries = new Map(previous.map((entry) => [pullRequestListKey(entry), entry]));
  for (const entry of incoming) {
    const key = pullRequestListKey(entry);
    const held = entries.get(key);
    if (!held || (entry.observedAt ?? 0) >= (held.observedAt ?? 0)) entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface PullRequestListPages {
  readonly head: PullRequestListResult;
  readonly entries: readonly PullRequestListEntry[];
  readonly nextCursors: PullRequestListResult["nextCursors"];
  readonly truncated: boolean;
  readonly limit: number;
  readonly continued: boolean;
}

export function pullRequestListHead(
  previous: PullRequestListPages | null,
  head: PullRequestListResult,
): PullRequestListPages {
  if (previous?.head === head) return previous;
  return previous?.continued
    ? { ...previous, head, entries: mergePullRequestListEntries(previous.entries, head.entries) }
    : {
        head,
        entries: head.entries,
        nextCursors: head.nextCursors,
        truncated: head.truncated,
        limit: PR_LIST_PAGE_SIZE,
        continued: false,
      };
}

/** The recorded pages with the current list head on top; before any answer is recorded, the head alone. */
export function shownPullRequestListPages(
  recorded: PullRequestListPages | null,
  head: PullRequestListResult | null,
): PullRequestListPages | null {
  return head ? pullRequestListHead(recorded, head) : recorded;
}

export function patchPullRequestListEntry(
  recorded: PullRequestListPages | null,
  head: PullRequestListResult | null,
  entry: PullRequestListEntry,
  patch: Partial<PullRequestListEntry>,
  observedAt: number,
): PullRequestListPages | null {
  const pages = shownPullRequestListPages(recorded, head);
  return (
    pages && {
      ...pages,
      entries: pages.entries.map((row) =>
        pullRequestListKey(row) === pullRequestListKey(entry)
          ? { ...row, ...patch, observedAt }
          : row,
      ),
    }
  );
}

export function pullRequestListInput(
  controls: PullRequestListControls,
  query: string,
  scope?: {
    readonly environmentId: EnvironmentId;
    readonly projectRefs: readonly ScopedProjectRef[];
  },
): PullRequestListInput {
  const parsed = parsePullRequestQuery(query);
  return {
    state: controls.state,
    involvement: controls.involvement,
    filters: { ...controls.filters, ...parsed.filters },
    limit: PR_LIST_PAGE_SIZE,
    ...(scope
      ? {
          projectIds: scope.projectRefs
            .filter((ref) => ref.environmentId === scope.environmentId)
            .map((ref) => ref.projectId),
        }
      : controls.projectId
        ? { projectId: ProjectId.make(controls.projectId) }
        : {}),
    ...(parsed.text ? { query: parsed.text } : {}),
  };
}

export function nextPullRequestListInput(
  pages: PullRequestListPages,
  input: PullRequestListInput,
): PullRequestListInput | null {
  if (Object.keys(pages.nextCursors).length)
    return { ...input, limit: PR_LIST_PAGE_SIZE, cursors: pages.nextCursors };
  return pages.truncated && pages.limit < 500
    ? { ...input, limit: Math.min(pages.limit + PR_LIST_PAGE_SIZE, 500) }
    : null;
}

export function appendPullRequestListPage(
  previous: PullRequestListPages,
  page: PullRequestListResult,
  input: PullRequestListInput,
): PullRequestListPages {
  return {
    ...previous,
    entries: mergePullRequestListEntries(previous.entries, page.entries),
    nextCursors: page.nextCursors,
    truncated: page.truncated,
    limit: input.limit ?? PR_LIST_PAGE_SIZE,
    continued: true,
  };
}

/**
 * A filter picker's rows: what is picked stays in view, then the loaded rows' values that match,
 * then the host's answers, each once. The host matched its own way (an author's display name, say),
 * so its answers are not narrowed again here.
 */
const FILTER_CHOICE_LIMIT = 100;

export function pullRequestFilterChoices(input: {
  readonly selected: readonly string[];
  readonly suggestions: readonly string[];
  readonly hosted: readonly string[];
  readonly query: string;
}): readonly string[] {
  const needle = input.query.trim().toLowerCase();
  const seen = new Set<string>();
  const rows: string[] = [];
  const add = (value: string) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(value);
  };
  const loaded = input.suggestions.filter((value) => value.toLowerCase().includes(needle));
  for (const value of input.selected) add(value);
  // Loaded matches alone could fill the list, so the host's answers get room after the first half.
  for (const value of loaded.slice(0, FILTER_CHOICE_LIMIT / 2)) add(value);
  for (const value of input.hosted) add(value);
  for (const value of loaded.slice(FILTER_CHOICE_LIMIT / 2)) add(value);
  return rows.slice(0, FILTER_CHOICE_LIMIT);
}

export function pullRequestListFacets(entries: readonly PullRequestListEntry[]) {
  return {
    authors: [
      ...new Set(entries.flatMap((entry) => (entry.author ? [entry.author.login] : []))),
    ].sort((a, b) => a.localeCompare(b)),
    labels: [...new Set(entries.flatMap((entry) => entry.labels.map((label) => label.name)))].sort(
      (a, b) => a.localeCompare(b),
    ),
    labelColors: pullRequestLabelColors(entries.flatMap((entry) => entry.labels)),
  };
}

/** Each label's dot color by lowercased name; the first usable color a name carries wins. */
export function pullRequestLabelColors(
  labels: readonly { readonly name: string; readonly color: string | null }[],
): Readonly<Record<string, string>> {
  const colors: Record<string, string> = {};
  for (const label of labels) {
    const key = label.name.toLowerCase();
    const color = pullRequestLabelColor(label.color);
    if (color && !(key in colors)) colors[key] = color;
  }
  return colors;
}

export function filterPullRequestList<
  Entry extends PullRequestListEntry & { environmentId?: string },
>(
  entries: readonly Entry[],
  controls: PullRequestListControls,
  viewers: PullRequestListResult["viewers"],
  query: string,
  localSearchHosts: ReadonlySet<string>,
  connectedEnvironmentIds?: ReadonlySet<string>,
  projectRefs?: readonly ScopedProjectRef[],
) {
  const normalize = (value: string) => value.toLowerCase();
  const parsed = parsePullRequestQuery(query);
  const words = parsed.text.toLowerCase().split(/\s+/).filter(Boolean);
  const filters = { ...controls.filters, ...parsed.filters };
  const filtered = entries.filter((entry) => {
    if (controls.state !== "all" && entry.state !== controls.state) return false;
    if (projectRefs) {
      if (
        !projectRefs.some(
          (ref) => ref.projectId === entry.projectId && ref.environmentId === entry.environmentId,
        )
      )
        return false;
    } else {
      if (controls.projectId && entry.projectId !== controls.projectId) return false;
      if (controls.projectEnvironmentId && entry.environmentId !== controls.projectEnvironmentId)
        return false;
    }
    const viewerKey = entry.environmentId ? `${entry.environmentId} ${entry.host}` : entry.host;
    const viewer = viewers[viewerKey];
    if (controls.involvement === "reviewing" && !entry.viewerReviewRequested) return false;
    if (
      controls.involvement === "authored" &&
      (!viewer || normalize(entry.author?.login ?? "") !== normalize(viewer))
    )
      return false;
    if ((filters.draft === "only" && !entry.isDraft) || (filters.draft === "hide" && entry.isDraft))
      return false;
    if (filters.author) {
      const author = resolvePullRequestAuthorFilter(filters.author, viewer);
      if (normalize(entry.author?.login ?? "") !== normalize(author)) return false;
    }
    if (filters.review && entry.reviewDecision && entry.reviewDecision !== filters.review)
      return false;
    if (filters.review === "none" && entry.reviewDecision) return false;
    if (filters.checks && entry.checksState && entry.checksState !== filters.checks) return false;
    const labels = new Set(entry.labels.map((label) => normalize(label.name)));
    if (filters.labels?.some((group) => !group.some((label) => labels.has(normalize(label)))))
      return false;
    if (filters.excludedLabels?.some((label) => labels.has(normalize(label)))) return false;
    if (words.length && localSearchHosts.has(viewerKey)) {
      const text =
        `${entry.repository} #${entry.number} ${entry.title} ${entry.author?.login ?? ""} ${entry.headBranch} ${entry.baseBranch} ${entry.labels.map((label) => label.name).join(" ")}`.toLowerCase();
      if (!words.every((word) => text.includes(word))) return false;
    }
    return true;
  });
  const reachable = (entry: Entry) =>
    !connectedEnvironmentIds ||
    (entry.environmentId !== undefined && connectedEnvironmentIds.has(entry.environmentId));
  const unique = new Map<string, Entry>();
  for (const entry of filtered) {
    const key = pullRequestListKey(entry);
    const held = unique.get(key);
    if (!held || (!reachable(held) && reachable(entry))) unique.set(key, entry);
  }
  return [...unique.values()].sort((a, b) =>
    controls.sort === "created"
      ? b.createdAt.localeCompare(a.createdAt)
      : controls.sort === "oldest"
        ? a.updatedAt.localeCompare(b.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function pullRequestListReviewStatus(
  entry: Pick<PullRequestListEntry, "reviewDecision" | "viewerReviewRequested">,
) {
  if (entry.reviewDecision === "changes-requested")
    return {
      label: "Changes",
      accessibleLabel: "Changes requested",
      icon: "person.fill.xmark",
      tint: "accent-danger-foreground",
    } as const;
  if (entry.reviewDecision === "approved")
    return {
      label: "Approved",
      accessibleLabel: "Reviews approved",
      icon: "person.fill.checkmark",
      tint: "accent-adaptive-emerald-600-400",
    } as const;
  if (entry.viewerReviewRequested)
    return {
      label: "Your review",
      accessibleLabel: "Your review requested",
      icon: "person.badge.clock",
      tint: "accent-warning-foreground",
    } as const;
  if (entry.reviewDecision === "review-required")
    return {
      label: "Review",
      accessibleLabel: "Review required",
      icon: "person.badge.clock",
      tint: "accent-icon-muted",
    } as const;
  return null;
}

export function pullRequestLabelColor(color: string | null) {
  const hex = color?.replace(/^#/, "");
  return hex && /^[\da-f]{6}$/i.test(hex) ? `#${hex}` : null;
}
