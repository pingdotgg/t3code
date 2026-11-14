import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type SearchTermsMatch,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly project?: EnvironmentProject;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
  /** Thread rows rank by match quality and use instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Listed last in its group, as the thread already open. */
  readonly secondary?: boolean;
  readonly run: () => void;
}

export interface CommandPaletteResult extends CommandPaletteItem {
  /** Listed because its messages match; the row shows the message snippet. */
  readonly fromMessages?: boolean;
  /** Title ranges the query matched, for highlighting. */
  readonly titleRanges?: ReadonlyArray<SearchRange>;
  /** Shown in place of the detail when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
}

/**
 * Ranks like the web palette: actions, projects, and threads order by their
 * best match, threads by match quality and use. Threads whose messages match
 * come last, in `messageMatchKeys` order, so late server results never move
 * the rows above them.
 */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  messageMatchKeys: ReadonlyArray<string>,
  now = Date.now(),
): CommandPaletteResult[] {
  const actionsOnly = query.startsWith(">");
  const normalizedQuery = foldSearchQuery(actionsOnly ? query.slice(1) : query);
  const candidates = actionsOnly ? items.filter((item) => item.kind === "action") : items;
  if (!normalizedQuery) return candidates.filter((item) => item.kind !== "project");

  // On equal match classes, groups keep this order, as on web.
  const kinds = ["action", "thread", "project"] as const;
  const groups = rankSearchGroups(
    kinds.map((kind) => ({ group: kind, items: candidates.filter((item) => item.kind === kind) })),
    (
      item,
      options,
    ): (SearchTermsMatch & { explain?: () => SearchMatchHint | undefined }) | null => {
      const match = item.threadSearch
        ? scoreThreadSearch(normalizedQuery, item.threadSearch, now, options)
        : scoreSearchTerms(normalizedQuery, [item.title, ...item.searchTerms], options);
      // The open thread, listed last, does not decide where its group sits.
      return match && item.secondary ? { ...match, groupQuality: 0 } : match;
    },
  );
  const threadsMatch = groups.some(({ group }) => group === "thread");
  const ranked = groups.flatMap(({ group, ranked: entries }) =>
    [...entries]
      // Stable, so rank order holds otherwise.
      .sort(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false),
      )
      .slice(
        0,
        group === "thread"
          ? PALETTE_THREAD_LIMIT
          : threadsMatch && !actionsOnly
            ? PALETTE_SECONDARY_LIMIT
            : entries.length,
      )
      .map(({ item, match }): CommandPaletteResult => {
        // Built only for the rows shown.
        const matchHint = match.explain?.();
        return { ...item, titleRanges: match.ranges, ...(matchHint ? { matchHint } : {}) };
      }),
  );
  if (actionsOnly) return ranked;

  const listed = new Set(ranked.map((item) => item.key));
  const threadByKey = new Map(
    items.filter((item) => item.kind === "thread").map((item) => [item.key, item]),
  );
  // `messageMatchKeys` arrive cut to what the palette shows; see `nextShownOrder`.
  const fromMessages = messageMatchKeys.flatMap((key) => {
    const item = threadByKey.get(key);
    return item && !listed.has(key) ? [{ ...item, fromMessages: true }] : [];
  });
  return [...ranked, ...fromMessages];
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}
