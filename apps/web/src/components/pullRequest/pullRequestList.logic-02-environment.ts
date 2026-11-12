import { resolvePullRequestAuthorFilter } from "@t3tools/contracts";
import type {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
  ProjectId,
  RepositoryIdentity,
  PullRequestAction,
  PullRequestActor,
  PullRequestDiffStat,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestState,
} from "@t3tools/contracts";

export interface EnvironmentPullRequestEntry extends PullRequestListEntry {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestStat extends PullRequestDiffStat {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestError extends PullRequestListProjectError {
  readonly environmentId: EnvironmentId;
}

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup<Entry extends PullRequestListEntry = PullRequestListEntry> {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

export interface PullRequestAuthorFacet {
  readonly actor: PullRequestActor;
  readonly count: number;
  readonly mergedCount: number;
}

export interface PullRequestLabelFacet extends PullRequestLabel {
  readonly count: number;
}

export type PullRequestViewers = PullRequestListResult["viewers"];

export type ScopedEntry = PullRequestListEntry & { readonly environmentId?: string };

export const pullRequestViewerKey = (entry: ScopedEntry): string =>
  `${entry.environmentId ?? ""} ${entry.host}`;

export const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

export function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function pullRequestLabelColor(color: string | null): string | null {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function collectPullRequestListFacets(
  entries: ReadonlyArray<PullRequestListEntry>,
  state: PullRequestListState,
) {
  const authors = new Map<string, PullRequestAuthorFacet>();
  const labels = new Map<string, PullRequestLabelFacet>();
  const uniqueEntries = new Map(entries.map((entry) => [pullRequestEntryKey(entry), entry]));
  for (const entry of uniqueEntries.values()) {
    const inState = state === "all" || entry.state === state;
    if (entry.author !== null) {
      const key = normalize(entry.author.login);
      if (key !== null) {
        const held = authors.get(key);
        authors.set(key, {
          actor: held?.actor ?? entry.author,
          count: (held?.count ?? 0) + Number(inState),
          mergedCount: (held?.mergedCount ?? 0) + Number(entry.state === "merged"),
        });
      }
    }
    if (!inState) continue;
    for (const label of entry.labels) {
      const key = normalize(label.name);
      if (key === null) continue;
      const held = labels.get(key);
      labels.set(key, {
        ...label,
        name: held?.name ?? label.name,
        color: held?.color ?? label.color,
        count: (held?.count ?? 0) + 1,
      });
    }
  }
  return {
    authors: [...authors.values()]
      .filter((author) => author.count > 0)
      .toSorted(
        (left, right) =>
          right.mergedCount - left.mergedCount ||
          right.count - left.count ||
          left.actor.login.localeCompare(right.actor.login),
      ),
    labels: [...labels.values()].toSorted(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name),
    ),
  };
}

/**
 * What a filter picker offers for `query`: the loaded rows that match keep their counts and lead,
 * then whatever the host found that no loaded row carries, so a name nobody has loaded yet is
 * still one search away.
 */
/** How many loaded matches come before the host's answers. */
export const HOSTED_CHOICE_ROOM = 15;

export function pullRequestAuthorChoices(
  facets: ReadonlyArray<PullRequestAuthorFacet>,
  hosted: ReadonlyArray<PullRequestActor>,
  query: string,
): ReadonlyArray<PullRequestAuthorFacet> {
  const needle = normalize(query);
  const loaded = facets.filter(
    (facet) =>
      needle === null ||
      facet.actor.login.toLowerCase().includes(needle) ||
      facet.actor.name?.toLowerCase().includes(needle),
  );
  const known = new Map(facets.map((facet) => [normalize(facet.actor.login), facet]));
  const seen = new Set(loaded.map((facet) => normalize(facet.actor.login)));
  const added: PullRequestAuthorFacet[] = [];
  for (const actor of hosted) {
    const key = normalize(actor.login);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(known.get(key) ?? { actor, count: 0, mergedCount: 0 });
  }
  // The picker shows a short list, and loaded matches alone could fill it.
  return [...loaded.slice(0, HOSTED_CHOICE_ROOM), ...added, ...loaded.slice(HOSTED_CHOICE_ROOM)];
}

/**
 * The author a filter names, as a choice: an author picked from the host's answer is on no
 * loaded row, so it stays shown after the search that found it clears.
 */
export function selectedPullRequestAuthor(
  facets: ReadonlyArray<PullRequestAuthorFacet>,
  hosted: ReadonlyArray<PullRequestActor>,
  value: string | undefined,
): PullRequestAuthorFacet | undefined {
  if (value === undefined) return undefined;
  const key = normalize(value);
  return (
    facets.find((facet) => normalize(facet.actor.login) === key) ?? {
      actor: hosted.find((actor) => normalize(actor.login) === key) ?? {
        login: value,
        name: null,
        avatarUrl: null,
      },
      count: 0,
      mergedCount: 0,
    }
  );
}

export function pullRequestLabelChoices(
  facets: ReadonlyArray<PullRequestLabelFacet>,
  hosted: ReadonlyArray<PullRequestLabel>,
  query: string,
): ReadonlyArray<PullRequestLabelFacet> {
  const needle = normalize(query);
  const loaded = facets.filter(
    (facet) => needle === null || facet.name.toLowerCase().includes(needle),
  );
  const known = new Map(facets.map((facet) => [normalize(facet.name), facet]));
  const seen = new Set(loaded.map((facet) => normalize(facet.name)));
  const added: PullRequestLabelFacet[] = [];
  for (const label of hosted) {
    const key = normalize(label.name);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(known.get(key) ?? { ...label, count: 0 });
  }
  return [...loaded, ...added];
}

export function pullRequestEntryViewer(
  entry: ScopedEntry,
  viewers: PullRequestViewers,
): string | null {
  return normalize(viewers[pullRequestViewerKey(entry)] ?? viewers[entry.host]);
}

export function isAuthoredByViewer(entry: ScopedEntry, viewers: PullRequestViewers): boolean {
  const viewer = pullRequestEntryViewer(entry, viewers);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function filterPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<Entry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  }
  return entries;
}

export function narrowPullRequestsToFilters<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  filters: {
    readonly state: PullRequestListState;
    readonly projectId: string | undefined;
    readonly host: string | undefined;
  },
): ReadonlyArray<Entry> {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (filters.projectId === undefined || entry.projectId === filters.projectId) &&
      (filters.host === undefined || entry.host === filters.host),
  );
}

export function matchesPullRequestFilters(
  entry: PullRequestListEntry,
  filters: PullRequestListFilters,
  viewer?: string | null,
): boolean {
  const labels = entry.labels.map((label) => label.name.trim().toLowerCase());
  const holds = (label: string) => labels.includes(label.trim().toLowerCase());
  return (
    (filters.draft === undefined || entry.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? entry.reviewDecision === undefined
        : entry.reviewDecision === filters.review)) &&
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      entry.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

export function groupPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const buckets: Record<PullRequestGroupKey, Entry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

export function pullRequestEntryKey(entry: ScopedEntry): string {
  const scope = entry.environmentId === undefined ? "" : `${entry.environmentId}:`;
  return `${scope}${entry.host}:${entry.repository}#${entry.number}`;
}

export interface PullRequestStatsTarget {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly refs: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>;
  };
}

export interface PullRequestStatsBatch extends PullRequestStatsTarget {
  readonly keys: ReadonlySet<string>;
}

export type PullRequestStatsPolicy = "visible" | "eager";

export interface PullRequestStatsScope {
  readonly key: string;
  readonly policy: PullRequestStatsPolicy;
}

export type PullRequestDiffStats = ReadonlyMap<
  string,
  { readonly additions: number; readonly deletions: number }
>;

/** New stats queries must not blank existing counts. */
export interface MergedPullRequestList {
  readonly viewers: PullRequestViewers;
  readonly providers: PullRequestListResult["providers"];
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly errors: ReadonlyArray<EnvironmentPullRequestError>;
  readonly truncated: boolean;
  readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
  readonly truncatedEnvironments: ReadonlyArray<string>;
}

export interface PullRequestPartitionsSnapshot {
  readonly authored: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly reviewing: ReadonlyArray<EnvironmentPullRequestEntry>;
}

/** Retain project scope during reconnect until projects arrive. */
export interface PullRequestListOverride {
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly updatedAt: string;
  readonly token: number;
  readonly at: number;
}

export type PullRequestQuickAction = "close" | "merge" | "ready" | "reopen";

