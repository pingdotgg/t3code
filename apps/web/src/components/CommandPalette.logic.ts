import {
  normalizeThreadPullRequestSearchQuery,
  threadPullRequestSearchTerms,
} from "@t3tools/shared/threadPullRequests";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";
import {
  type KeybindingCommand,
  type FilesystemBrowseEntry,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ScopedThreadRef,
  type OrchestrationTranscriptSearchMatch,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { type ReactNode } from "react";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";
export const ADDON_ICON_CLASS = "size-4";

export type PaletteMatchSource =
  | "Title"
  | "Content"
  | "Project"
  | "Branch"
  | "PR"
  | "Path"
  | "Env"
  | "ID"
  | "Command";

export type PaletteScopeKind = "project" | "thread" | "archived";

export interface ProjectPaletteScope {
  readonly kind: "project";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

export interface ThreadPaletteScope {
  readonly kind: "thread";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}

export interface ArchivedPaletteScope {
  readonly kind: "archived";
  readonly label: "Archived";
}

export const ARCHIVED_PALETTE_SCOPE: ArchivedPaletteScope = {
  kind: "archived",
  label: "Archived",
};

export type PaletteScope = ProjectPaletteScope | ThreadPaletteScope | ArchivedPaletteScope;

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly searchIndex?: CommandPaletteSearchIndex;
  readonly searchTermSources?: ReadonlyArray<PaletteMatchSource>;
  /** Pressing Tab on this row scopes search to this value. */
  readonly scope?: PaletteScope;
  readonly title: ReactNode;
  readonly description?: string;
  readonly timestamp?: string;
  readonly environmentId?: EnvironmentId;
  readonly icon: ReactNode;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
}

export interface CommandPaletteSearchIndex {
  readonly normalizedTerms: ReadonlyArray<string>;
  readonly literalTermIndex?: number;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface TranscriptSearchItem {
  readonly environmentId: EnvironmentId;
  readonly match: OrchestrationTranscriptSearchMatch;
}

function threadSearchValue(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `thread:${environmentId}:${threadId}`;
}

export function buildTranscriptActionItems(input: {
  readonly matches: readonly TranscriptSearchItem[];
  readonly metadataGroups: readonly CommandPaletteGroup[];
  readonly icon: ReactNode;
  readonly runThread: (ref: ScopedThreadRef & { messageId: string }) => Promise<void>;
}): CommandPaletteActionItem[] {
  const metadataValues = new Set(
    input.metadataGroups.flatMap((group) => group.items.map((item) => item.value)),
  );
  return input.matches
    .filter(
      ({ environmentId, match }) =>
        !metadataValues.has(threadSearchValue(environmentId, match.threadId)),
    )
    .map(({ environmentId, match }) => {
      const context = [match.projectTitle, match.branch ? `#${match.branch}` : null]
        .filter((part): part is string => part !== null)
        .join(" · ");
      const searchTerms = [match.title, match.excerpt];
      const { searchIndex, searchTermSources } = buildPaletteSearchParts(searchTerms, [
        "Title",
        "Content",
      ]);
      return {
        kind: "action",
        value: `transcript:${environmentId}:${match.threadId}`,
        environmentId,
        searchTerms,
        searchIndex,
        searchTermSources,
        scope: {
          kind: "thread",
          environmentId,
          threadId: match.threadId,
          label: match.title,
        },
        title: match.title,
        description: `${context ? `${context} · ` : ""}${match.role === "user" ? "You" : "Assistant"}: ${match.excerpt}`,
        icon: input.icon,
        run: () =>
          input.runThread({
            environmentId,
            threadId: match.threadId,
            messageId: match.messageId,
          }),
      };
    });
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export function filterBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseFilterQuery: string;
  highlightedItemValue: string | null;
}): {
  filteredEntries: FilesystemBrowseEntry[];
  highlightedEntry: FilesystemBrowseEntry | null;
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerFilter = input.browseFilterQuery.toLowerCase();
  const showHidden = input.browseFilterQuery.startsWith(".");

  const filteredEntries = input.browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  let highlightedEntry: FilesystemBrowseEntry | null = null;
  if (input.highlightedItemValue?.startsWith("browse:")) {
    const highlightedPath = input.highlightedItemValue.slice("browse:".length);
    highlightedEntry = filteredEntries.find((entry) => entry.fullPath === highlightedPath) ?? null;
  }

  const exactEntry =
    input.browseFilterQuery.length > 0
      ? (filteredEntries.find((entry) => entry.name === input.browseFilterQuery) ?? null)
      : null;

  return { filteredEntries, highlightedEntry, exactEntry };
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildCommandPaletteSearchIndex(
  searchTerms: ReadonlyArray<string>,
): CommandPaletteSearchIndex {
  return {
    normalizedTerms: searchTerms
      .filter((term) => term.length > 0)
      .map((term) => normalizeSearchText(term)),
  };
}

function buildPaletteSearchParts(
  searchTerms: ReadonlyArray<string>,
  sources: ReadonlyArray<PaletteMatchSource>,
): { searchIndex: CommandPaletteSearchIndex; searchTermSources: PaletteMatchSource[] } {
  const normalizedTerms: string[] = [];
  const filteredSources: PaletteMatchSource[] = [];
  for (const [index, term] of searchTerms.entries()) {
    if (term.length === 0) continue;
    normalizedTerms.push(normalizeSearchText(term));
    filteredSources.push(sources[index] ?? "Command");
  }
  return {
    searchIndex: {
      normalizedTerms,
      ...(filteredSources.includes("ID")
        ? { literalTermIndex: filteredSources.indexOf("ID") }
        : {}),
    },
    searchTermSources: filteredSources,
  };
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => {
    const searchTerms = [project.name, project.cwd, project.environmentId];
    const { searchIndex, searchTermSources } = buildPaletteSearchParts(searchTerms, [
      "Title",
      "Path",
      "Env",
    ]);

    return {
      kind: "action",
      value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
      searchTerms,
      searchIndex,
      searchTermSources,
      scope: {
        kind: "project",
        environmentId: project.environmentId,
        projectId: project.id,
        label: project.name,
      },
      title: project.name,
      environmentId: project.environmentId,
      description: project.cwd,
      icon: input.icon(project),
      run: async () => {
        await input.runProject(project);
      },
    };
  });
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "environmentId"
  | "id"
  | "projectId"
  | "pullRequest"
  | "pullRequests"
  | "title"
> & {
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  archived?: boolean;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  icon: ReactNode;
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => (thread.archivedAt !== null) === (input.archived ?? false)),
    input.sortOrder,
    input.limit,
  );

  return sortedThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);
    const pullRequestTerms = threadPullRequestSearchTerms(thread);
    const searchTerms = [
      thread.title,
      ...pullRequestTerms,
      projectTitle ?? ``,
      thread.branch ?? ``,
      thread.environmentId,
      thread.id,
    ];
    const { searchIndex, searchTermSources } = buildPaletteSearchParts(searchTerms, [
      "Title",
      ...pullRequestTerms.map(() => "PR" as PaletteMatchSource),
      "Project",
      "Branch",
      "Env",
      "ID",
    ]);

    return Object.assign(
      {
        kind: "action" as const,
        value: threadSearchValue(thread.environmentId, thread.id),
        searchTerms,
        searchIndex,
        searchTermSources,
        scope: {
          kind: "thread",
          environmentId: thread.environmentId,
          threadId: thread.id,
          label: thread.title,
        } satisfies ThreadPaletteScope,
        title: thread.title,
        environmentId: thread.environmentId,
        description: descriptionParts.join(` · `),
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

function getCommandPaletteSearchIndex(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
): CommandPaletteSearchIndex {
  return item.searchIndex ?? buildCommandPaletteSearchIndex(item.searchTerms);
}

function scorePaletteToken(
  field: string,
  token: string,
  fieldBase: number,
  allowFuzzy: boolean,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(allowFuzzy && token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

function scorePaletteIndex(
  index: CommandPaletteSearchIndex,
  tokens: ReadonlyArray<string>,
): { score: number; bestTermIndex: number; sourceTermIndex: number } | null {
  if (index.normalizedTerms.length === 0 || tokens.length === 0) {
    return null;
  }
  let total = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let sourceTermIndex = 0;
  let bestTermIndex = Number.POSITIVE_INFINITY;
  for (const token of tokens) {
    let tokenBest: number | null = null;
    let tokenBestIndex = -1;
    for (const [termIndex, field] of index.normalizedTerms.entries()) {
      const fieldScore = scorePaletteToken(
        field,
        token,
        termIndex * 10,
        termIndex !== index.literalTermIndex,
      );
      if (fieldScore === null) {
        continue;
      }
      if (tokenBest === null || fieldScore < tokenBest) {
        tokenBest = fieldScore;
        tokenBestIndex = termIndex;
      }
      if (termIndex < bestTermIndex) {
        bestTermIndex = termIndex;
      }
    }
    if (tokenBest === null || tokenBestIndex < 0) {
      return null;
    }
    total += tokenBest;
    if (tokenBest < bestScore) {
      bestScore = tokenBest;
      sourceTermIndex = tokenBestIndex;
    }
  }
  return { score: total, bestTermIndex, sourceTermIndex };
}

export function tokenizePaletteQuery(normalizedQuery: string): string[] {
  return normalizeSearchQuery(normalizedQuery)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

export function getPaletteMatchSource(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): PaletteMatchSource | null {
  const tokens = tokenizePaletteQuery(
    normalizeSearchText(normalizeThreadPullRequestSearchQuery(normalizedQuery) ?? normalizedQuery),
  );
  if (tokens.length === 0) {
    return null;
  }
  const index = getCommandPaletteSearchIndex(item);
  const scored = scorePaletteIndex(index, tokens);
  if (!scored) {
    return null;
  }
  const sources = item.searchTermSources;
  if (sources && sources[scored.sourceTermIndex]) {
    return sources[scored.sourceTermIndex] ?? null;
  }
  if (item.value.startsWith("transcript:")) {
    return "Content";
  }
  if (item.value.startsWith("thread:") || item.value.startsWith("project:")) {
    return "Title";
  }
  return null;
}

export interface PaletteHighlightPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

export function splitPaletteHighlightParts(text: string, query: string): PaletteHighlightPart[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0 || text.length === 0) {
    return [{ text, highlighted: false, start: 0 }];
  }
  const normalizedText = text.toLowerCase();
  const fullIndex = normalizedText.indexOf(normalizedQuery);
  const tokens =
    fullIndex === -1
      ? normalizedQuery.split(/\s+/u).filter((token) => token.length > 0)
      : [normalizedQuery];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    if (token.length === 0) continue;
    let cursor = 0;
    while (cursor < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(token, cursor);
      if (matchIndex === -1) break;
      ranges.push({ start: matchIndex, end: matchIndex + token.length });
      cursor = matchIndex + token.length;
    }
  }
  if (ranges.length === 0) {
    return [{ text, highlighted: false, start: 0 }];
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  const parts: PaletteHighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(range.start, range.end),
      highlighted: true,
      start: range.start,
    });
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(
    normalizeThreadPullRequestSearchQuery(searchQuery) ?? searchQuery,
  );

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  const tokens = tokenizePaletteQuery(normalizedQuery);

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const searchIndex = getCommandPaletteSearchIndex(item);
        const scored = scorePaletteIndex(searchIndex, tokens);
        if (!scored) {
          return null;
        }

        return {
          item,
          index,
          field: scored.bestTermIndex,
          rank: scored.score,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          item: (typeof group.items)[number];
          index: number;
          field: number;
          rank: number;
        } => entry !== null,
      )
      .toSorted(
        (left, right) =>
          left.field - right.field || left.rank - right.rank || left.index - right.index,
      )
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export type PaletteScopeThreadInput = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "projectId" | "parentThreadId" | "title"
>;

export type PaletteScopeProjectInput = Pick<Project, "id" | "environmentId" | "name">;

export function paletteScopeKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return threadSearchValue(environmentId, threadId);
}

export function isSamePaletteScope(left: PaletteScope, right: PaletteScope): boolean {
  if (left.kind === "archived" && right.kind === "archived") {
    return true;
  }
  if (left.kind === "project" && right.kind === "project") {
    return left.environmentId === right.environmentId && left.projectId === right.projectId;
  }
  return left.kind === "thread" && right.kind === "thread"
    ? left.environmentId === right.environmentId && left.threadId === right.threadId
    : false;
}

export function formatPaletteScopeLabels(scopes: ReadonlyArray<PaletteScope>): string {
  return scopes.map((scope) => scope.label).join(", ");
}

/**
 * Resolve location scopes to the set of visible thread keys.
 * Project scopes match member threads; thread scopes match the thread plus its
 * subthreads. The scope root is always included even when it is absent from
 * the list (archived or not yet loaded). Archived selects a data source in the
 * caller; by itself it does not constrain projects, subtrees, or environments.
 */
export function resolvePaletteScopeThreadKeys(
  scopes: ReadonlyArray<PaletteScope>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): Set<string> {
  const projectKeys = new Set<string>();
  const threadKeys = new Set<string>();
  if (scopes.length === 0) {
    return projectKeys;
  }
  const childrenByKey = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) {
      continue;
    }
    const parentKey = paletteScopeKey(thread.environmentId, thread.parentThreadId);
    const siblings = childrenByKey.get(parentKey);
    const key = paletteScopeKey(thread.environmentId, thread.id);
    if (siblings) {
      siblings.push(key);
    } else {
      childrenByKey.set(parentKey, [key]);
    }
  }
  const collectSubtree = (rootKey: string): void => {
    const stack = [rootKey];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (threadKeys.has(key)) {
        continue;
      }
      threadKeys.add(key);
      for (const child of childrenByKey.get(key) ?? []) {
        stack.push(child);
      }
    }
  };
  for (const scope of scopes) {
    if (scope.kind === "project") {
      for (const thread of threads) {
        if (thread.environmentId === scope.environmentId && thread.projectId === scope.projectId) {
          projectKeys.add(paletteScopeKey(thread.environmentId, thread.id));
        }
      }
    } else if (scope.kind === "thread") {
      collectSubtree(paletteScopeKey(scope.environmentId, scope.threadId));
    }
  }
  if (!scopes.some((scope) => scope.kind !== "archived")) {
    return new Set(threads.map((thread) => paletteScopeKey(thread.environmentId, thread.id)));
  }
  if (!scopes.some((scope) => scope.kind === "project")) {
    return threadKeys;
  }
  if (!scopes.some((scope) => scope.kind === "thread")) {
    return projectKeys;
  }
  return new Set([...threadKeys].filter((key) => projectKeys.has(key)));
}

function isProjectScopeTarget(
  scope: PaletteScope | undefined,
  scopes: ReadonlyArray<PaletteScope>,
): boolean {
  if (scope?.kind !== "project") {
    return false;
  }
  return (
    !scopes.some((active) => active.kind !== "archived") ||
    scopes.some(
      (active) =>
        active.kind === "project" &&
        active.environmentId === scope.environmentId &&
        active.projectId === scope.projectId,
    )
  );
}

/**
 * Narrow content rows to the active scopes. Thread and transcript rows pass
 * when their thread key resolves inside a scope; project rows pass only when
 * their own project is scoped. Actions, submenus, and browse rows always
 * pass — callers decide which groups scopes apply to.
 *
 * Extension seam: add a PaletteScope union member, a qualifier case in
 * parsePaletteScopeQualifiers, and a predicate case here.
 */
export function filterPaletteItemsByScopes<
  TItem extends Pick<CommandPaletteItem, "scope" | "value">,
>(
  items: ReadonlyArray<TItem>,
  scopes: ReadonlyArray<PaletteScope>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): ReadonlyArray<TItem> {
  if (scopes.length === 0) {
    return items;
  }
  const allowed = resolvePaletteScopeThreadKeys(scopes, threads);
  return items.filter((item) => {
    if (item.scope?.kind === "thread") {
      return allowed.has(paletteScopeKey(item.scope.environmentId, item.scope.threadId));
    }
    if (item.scope?.kind === "project") {
      return isProjectScopeTarget(item.scope, scopes);
    }
    return true;
  });
}

export function filterTranscriptMatchesByScopes(
  matches: ReadonlyArray<TranscriptSearchItem>,
  scopes: ReadonlyArray<PaletteScope>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): ReadonlyArray<TranscriptSearchItem> {
  if (scopes.length === 0) {
    return matches;
  }
  const allowed = resolvePaletteScopeThreadKeys(scopes, threads);
  return matches.filter(({ environmentId, match }) =>
    allowed.has(paletteScopeKey(environmentId, match.threadId)),
  );
}

export function selectPaletteScopeEnvironmentIds(
  scopes: ReadonlyArray<PaletteScope>,
): EnvironmentId[] | null {
  const environmentScopes = scopes.filter((scope) => scope.kind !== "archived");
  if (environmentScopes.length === 0) {
    return null;
  }
  return [...new Set(environmentScopes.map((scope) => scope.environmentId))];
}

function resolveProjectQualifier(
  value: string,
  projects: ReadonlyArray<PaletteScopeProjectInput>,
): ProjectPaletteScope | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const ranked = projects
    .map((project) => {
      const name = project.name.toLocaleLowerCase();
      if (name === normalized) {
        return { project, rank: 0 };
      }
      if (name.startsWith(normalized)) {
        return { project, rank: 1 };
      }
      return name.includes(normalized) ? { project, rank: 2 } : null;
    })
    .filter((entry): entry is { project: PaletteScopeProjectInput; rank: number } => entry !== null)
    .toSorted((left, right) => left.rank - right.rank);
  const winner = ranked[0]?.project;
  return winner
    ? {
        kind: "project",
        environmentId: winner.environmentId,
        projectId: winner.id,
        label: winner.name,
      }
    : null;
}

function resolveThreadQualifier(
  value: string,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): ThreadPaletteScope | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const ranked = threads
    .map((thread) => {
      const title = thread.title.toLocaleLowerCase();
      if (title === normalized) {
        return { thread, rank: 0 };
      }
      if (title.startsWith(normalized)) {
        return { thread, rank: 1 };
      }
      return title.includes(normalized) ? { thread, rank: 2 } : null;
    })
    .filter((entry): entry is { thread: PaletteScopeThreadInput; rank: number } => entry !== null)
    .toSorted((left, right) => left.rank - right.rank);
  const winner = ranked[0]?.thread;
  return winner
    ? {
        kind: "thread",
        environmentId: winner.environmentId,
        threadId: winner.id,
        label: winner.title,
      }
    : null;
}

const PALETTE_SCOPE_QUALIFIER_PATTERN = /^([A-Za-z]+):(?:"([^"]+)"|(\S+))\s+/;
const PALETTE_TRAILING_QUALIFIER_PATTERN = /^([A-Za-z]+):(?:"([^"]+)"|(\S+))\s*$/;

export interface ParsedPaletteScopes {
  readonly scopes: PaletteScope[];
  readonly text: string;
}

function resolveScopeQualifier(
  keyword: string,
  value: string,
  projects: ReadonlyArray<PaletteScopeProjectInput>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): PaletteScope | null {
  if (keyword === "project") {
    return resolveProjectQualifier(value, projects);
  }
  if (keyword === "thread") {
    return resolveThreadQualifier(value, threads);
  }
  return null;
}

/**
 * Pull leading `archived`, `project:name` / `thread:title` qualifiers off the query and
 * resolve them to scope chips. The trailing-space requirement keeps a
 * qualifier being typed (`project:t`) as plain text until it is committed
 * with space or Tab. Unresolvable qualifiers stay in the text.
 * Extension seam: add the qualifier keyword alongside its PaletteScope kind.
 */
export function parsePaletteScopeQualifiers(
  query: string,
  projects: ReadonlyArray<PaletteScopeProjectInput>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): ParsedPaletteScopes {
  const scopes: PaletteScope[] = [];
  let text = query;
  for (;;) {
    const archivedMatch = /^archived\s+/i.exec(text);
    if (archivedMatch) {
      if (!scopes.some((scope) => scope.kind === "archived")) {
        scopes.push(ARCHIVED_PALETTE_SCOPE);
      }
      text = text.slice(archivedMatch[0].length);
      continue;
    }
    const match = PALETTE_SCOPE_QUALIFIER_PATTERN.exec(text);
    if (!match) {
      break;
    }
    const resolved = resolveScopeQualifier(
      match[1]!.toLocaleLowerCase(),
      match[2] ?? match[3] ?? "",
      projects,
      threads,
    );
    if (!resolved || scopes.some((scope) => isSamePaletteScope(scope, resolved))) {
      break;
    }
    scopes.push(resolved);
    text = text.slice(match[0].length);
  }
  return { scopes, text };
}

/**
 * Match when the whole query is a single qualifier (`project:t3`), so Tab can
 * commit it as a chip instead of scoping the highlighted row.
 */
export function parseTrailingPaletteScopeQualifier(
  query: string,
  projects: ReadonlyArray<PaletteScopeProjectInput>,
  threads: ReadonlyArray<PaletteScopeThreadInput>,
): PaletteScope | null {
  if (query.trim().toLowerCase() === "archived") {
    return ARCHIVED_PALETTE_SCOPE;
  }
  const match = PALETTE_TRAILING_QUALIFIER_PATTERN.exec(query);
  if (!match) {
    return null;
  }
  return resolveScopeQualifier(
    match[1]!.toLocaleLowerCase(),
    match[2] ?? match[3] ?? "",
    projects,
    threads,
  );
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void;
  browseTo: (name: string) => void;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}
