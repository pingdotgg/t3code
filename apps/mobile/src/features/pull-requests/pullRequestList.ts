import { parsePullRequestQuery } from "@t3tools/client-runtime/pull-request-query";
import {
  ProjectId,
  resolvePullRequestAuthorFilter,
  type EnvironmentId,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListResult,
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

export function pullRequestListInput(
  controls: PullRequestListControls,
  query: string,
): PullRequestListInput {
  const parsed = parsePullRequestQuery(query);
  return {
    state: controls.state,
    involvement: controls.involvement,
    filters: { ...controls.filters, ...parsed.filters },
    limit: PR_LIST_PAGE_SIZE,
    ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
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

export function pullRequestListFacets(entries: readonly PullRequestListEntry[]) {
  return {
    authors: [
      ...new Set(entries.flatMap((entry) => (entry.author ? [entry.author.login] : []))),
    ].sort((a, b) => a.localeCompare(b)),
    labels: [...new Set(entries.flatMap((entry) => entry.labels.map((label) => label.name)))].sort(
      (a, b) => a.localeCompare(b),
    ),
  };
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
) {
  const normalize = (value: string) => value.toLowerCase();
  const parsed = parsePullRequestQuery(query);
  const words = parsed.text.toLowerCase().split(/\s+/).filter(Boolean);
  const filters = { ...controls.filters, ...parsed.filters };
  const filtered = entries.filter((entry) => {
    if (controls.state !== "all" && entry.state !== controls.state) return false;
    if (controls.projectId && entry.projectId !== controls.projectId) return false;
    if (controls.projectEnvironmentId && entry.environmentId !== controls.projectEnvironmentId)
      return false;
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
