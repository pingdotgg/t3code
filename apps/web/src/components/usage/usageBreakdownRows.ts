/**
 * The breakdown table as a flat list of rows: top-level items, the children an
 * expanded row lists under it, thread families with their main conversation,
 * "Show N more" rows and the grey "Other" group that matches the chart.
 */
import {
  addTotals,
  childDimension,
  emptyTotals,
  familyTotals,
  foldFacts,
  isCacheHeavy,
  keyFor,
  matchesQuery,
  metricOf,
  OTHER_SERIES,
  rankEntries,
  type RankedEntry,
  type ThreadTree,
  type UsageDimension,
  type UsageExplorerMetric,
  type UsageFact,
  type UsageSort,
  type UsageTotals,
} from "./usageExplorerModel";

export type BreakdownDimension = UsageDimension | "account";

/** Top-level rows before "Show more". */
const ROW_CAP = 10;
/** Children listed under an expanded row before "Show more". */
const CHILD_CAP = 5;
/** Sub-agents listed under an open thread before "Show more". */
const THREAD_CHILD_CAP = 8;

interface RowBase {
  /** Unique within the table; also the expansion key. */
  readonly path: string;
  readonly depth: number;
}

export interface ItemRow extends RowBase {
  readonly kind: "item";
  readonly dimension: BreakdownDimension;
  readonly key: string;
  readonly totals: UsageTotals;
  /** Share of whatever the row sits under, and that thing's name. */
  readonly share: number;
  readonly shareOf: string;
  /** Swatch colour for top-level rows that are chart series. */
  readonly color: string | null;
  readonly hidden: boolean;
  readonly expandable: boolean;
  readonly open: boolean;
  /** For thread rows: direct sub-agents shown when opened, and all below. */
  readonly subagents: number;
  readonly allSubagents: number;
  readonly cacheHeavy: boolean;
  /** Keys of the focus path down to this row, for Focus on nested rows. */
  readonly ancestors: readonly { readonly dimension: BreakdownDimension; readonly key: string }[];
  readonly previous: UsageTotals | undefined;
}

export interface LeafRow extends RowBase {
  readonly kind: "leaf";
  /** "Main conversation", or a sub-agent with nothing under it. */
  readonly label: string;
  readonly totals: UsageTotals;
  readonly share: number;
  readonly shareOf: string;
}

export interface MoreRow extends RowBase {
  readonly kind: "more";
  /** Expansion key that shows the rest. */
  readonly target: string;
  readonly hiddenCount: number;
  readonly noun: string;
  readonly hiddenShare: number;
}

export interface FewerRow extends RowBase {
  readonly kind: "fewer";
  readonly target: string;
}

export interface OtherRow extends RowBase {
  readonly kind: "other";
  readonly members: readonly string[];
  readonly totals: UsageTotals;
  readonly share: number;
  readonly open: boolean;
  readonly hidden: boolean;
}

export type BreakdownRow = ItemRow | LeafRow | MoreRow | FewerRow | OtherRow;

export interface BreakdownInput {
  readonly dimension: UsageDimension;
  readonly facts: readonly UsageFact[];
  readonly tree: ThreadTree;
  readonly metric: UsageExplorerMetric;
  readonly sort: UsageSort | null;
  readonly nameOf: (dimension: BreakdownDimension, key: string) => string;
  readonly nounOf: (dimension: BreakdownDimension, count: number) => string;
  /** Chart colour per top-level key; keys without one are in Other. */
  readonly seriesOf: (key: string) => string;
  readonly colorOf: (key: string) => string;
  readonly hidden: ReadonlySet<string>;
  readonly favorites: ReadonlySet<string>;
  readonly accountsOfProvider: (provider: string) => number;
  /** Rows the user opened, by path, and lists showing all children, by path. */
  readonly open: ReadonlySet<string>;
  readonly showAll: ReadonlySet<string>;
  readonly query: string;
  readonly previous?: ReadonlyMap<string, UsageTotals>;
}

const OTHER_PATH = "\u0000other";

const share = (part: UsageTotals, whole: number, metric: UsageExplorerMetric) =>
  whole === 0 ? 0 : metricOf(part, metric) / whole;

const restShare = (
  entries: readonly RankedEntry[],
  from: number,
  whole: number,
  metric: UsageExplorerMetric,
) =>
  whole === 0
    ? 0
    : entries.slice(from).reduce((sum, e) => sum + metricOf(e.totals, metric), 0) / whole;

export function buildBreakdownRows(input: BreakdownInput): readonly BreakdownRow[] {
  const { dimension, facts, tree, metric, sort, nameOf, open, showAll, query } = input;
  const rows: BreakdownRow[] = [];
  const whole = metricOf(
    facts.reduce((totals, fact) => addTotals(totals, fact), emptyTotals()),
    metric,
  );
  const search = query.trim();
  // Threads whose title, or a model they used, matches the search, and every
  // thread above them.
  const matchedThreads = new Set<string>();
  if (search !== "") {
    const mark = (key: string) => {
      for (let up: string | undefined = key; up !== undefined; up = tree.parentOf.get(up)) {
        matchedThreads.add(up);
      }
    };
    for (const [key, info] of tree.info) {
      if (info.title !== null && matchesQuery(info.title, search)) mark(key);
    }
    for (const fact of facts) {
      if (fact.thread !== null && matchesQuery(fact.model, search)) mark(fact.thread);
    }
  }
  const threadMatches = (key: string) => search === "" || matchedThreads.has(key);

  // Per-thread totals for a scope, computed once however many rows read them.
  const scopes = new WeakMap<readonly UsageFact[], ScopeThreads>();
  const threadsIn = (scope: readonly UsageFact[]): ScopeThreads => {
    let cached = scopes.get(scope);
    if (cached === undefined) {
      cached = {
        families: familyTotals(scope, tree),
        own: foldFacts(scope, (fact) => fact.thread),
        any: scope.some((fact) => fact.thread !== null),
      };
      scopes.set(scope, cached);
    }
    return cached;
  };

  /**
   * Whether something an item lists under it matches the search: a project's
   * threads, a provider's accounts and models, an account's models, a model's
   * projects. Such an item stays and opens, so the match is reachable.
   */
  const childMatches = (dim: BreakdownDimension, key: string, scope: readonly UsageFact[]) =>
    scope.some((fact) => {
      if (keyFor(dim, fact, tree) !== key) return false;
      switch (dim) {
        case "project":
          return fact.thread !== null && threadMatches(tree.rootOf(fact.thread));
        case "provider":
          return (
            matchesQuery(fact.model, search) ||
            matchesQuery(nameOf("account", fact.account), search)
          );
        case "account":
          return matchesQuery(fact.model, search);
        case "model":
          return matchesQuery(nameOf("project", fact.project), search);
        case "thread":
          return false;
      }
    });
  const ownMatch = (dim: BreakdownDimension, key: string) =>
    matchesQuery(nameOf(dim, key), search) || (dim === "thread" && threadMatches(key));
  const itemMatches = (dim: BreakdownDimension, key: string, scope: readonly UsageFact[]) =>
    search === "" || ownMatch(dim, key) || childMatches(dim, key, scope);

  const ranked = (
    dim: BreakdownDimension,
    scope: readonly UsageFact[],
    pinned?: ReadonlySet<string>,
  ) =>
    rankEntries(
      dim === "thread"
        ? new Map([...threadsIn(scope).families].filter(([key]) => !tree.parentOf.has(key)))
        : foldFacts(scope, (fact) => keyFor(dim, fact, tree)),
      {
        metric,
        sort,
        nameOf: (key) => nameOf(dim, key),
        ...(pinned === undefined ? {} : { pinned }),
        ...(input.previous === undefined || dim !== dimension ? {} : { previous: input.previous }),
      },
    ).filter((entry) => itemMatches(dim, entry.key, scope));

  const pushItem = (
    dim: BreakdownDimension,
    entry: RankedEntry,
    path: string,
    depth: number,
    parentTotal: number,
    shareOf: string,
    scope: readonly UsageFact[],
    ancestors: ItemRow["ancestors"],
    topLevel: boolean,
  ) => {
    const childDim = childDimension(
      dim,
      dim === "provider" ? input.accountsOfProvider(entry.key) : 0,
    );
    const isThread = dim === "thread";
    const scopeThreads = isThread || dim === "project" ? threadsIn(scope) : undefined;
    const own = isThread ? scopeThreads?.own.get(entry.key) : undefined;
    const liveChildren = isThread
      ? (tree.childrenOf.get(entry.key) ?? []).filter((child) => scopeThreads?.families.has(child))
      : [];
    const expandable = isThread
      ? liveChildren.length > 0
      : childDim !== null && depth < 3 && !(dim === "project" && !scopeThreads?.any);
    // A search opens the path to its matches.
    const isOpen =
      expandable &&
      (open.has(path) ||
        (search !== "" &&
          (isThread ? liveChildren.some(threadMatches) : !ownMatch(dim, entry.key)) &&
          (isThread || childMatches(dim, entry.key, scope))));
    const familyCount = isThread ? (scopeThreads?.families.get(entry.key)?.descendants ?? 0) : 0;
    rows.push({
      kind: "item",
      path,
      depth,
      dimension: dim,
      key: entry.key,
      totals: entry.totals,
      share: share(entry.totals, parentTotal, metric),
      shareOf,
      color: topLevel ? input.colorOf(entry.key) : null,
      hidden: topLevel && input.hidden.has(entry.key),
      expandable,
      open: isOpen,
      subagents: liveChildren.length,
      allSubagents: familyCount,
      cacheHeavy: isThread && isCacheHeavy(own),
      ancestors,
      previous: topLevel ? input.previous?.get(entry.key) : undefined,
    });
    if (!isOpen) return;
    const nextAncestors = [...ancestors, { dimension: dim, key: entry.key }];
    const name = nameOf(dim, entry.key);
    const total = metricOf(entry.totals, metric);
    if (isThread) {
      if (own !== undefined) {
        rows.push({
          kind: "leaf",
          path: `${path}\u0000main`,
          depth: depth + 1,
          label: "Main conversation",
          totals: own,
          share: share(own, total, metric),
          shareOf: name,
        });
      }
      const childEntries = rankEntries(
        new Map(
          liveChildren.map((child) => [child, scopeThreads?.families.get(child) ?? emptyTotals()]),
        ),
        { metric, sort: null, nameOf: (key) => nameOf("thread", key) },
      ).filter((child) => threadMatches(child.key));
      pushChildren(
        "thread",
        childEntries,
        path,
        depth + 1,
        total,
        name,
        scope,
        nextAncestors,
        THREAD_CHILD_CAP,
      );
      return;
    }
    if (childDim === null) return;
    const childScope = scope.filter((fact) => keyFor(dim, fact, tree) === entry.key);
    pushChildren(
      childDim,
      ranked(childDim, childScope),
      path,
      depth + 1,
      total,
      name,
      childScope,
      nextAncestors,
      CHILD_CAP,
    );
    if (childDim === "thread")
      pushUnthreaded(childScope, `${path}\u0000none`, depth + 1, total, name);
  };

  /** Usage no thread holds, such as Cursor's, so a project's rows still add up. */
  const pushUnthreaded = (
    scope: readonly UsageFact[],
    path: string,
    depth: number,
    parentTotal: number,
    shareOf: string,
  ) => {
    if (search !== "") return;
    const none = foldFacts(scope, (fact) => (fact.thread === null ? "none" : null)).get("none");
    if (none === undefined) return;
    rows.push({
      kind: "leaf",
      path,
      depth,
      label: "Not in a thread",
      totals: none,
      share: share(none, parentTotal, metric),
      shareOf,
    });
  };

  const pushChildren = (
    dim: BreakdownDimension,
    entries: readonly RankedEntry[],
    parentPath: string,
    depth: number,
    parentTotal: number,
    parentName: string,
    scope: readonly UsageFact[],
    ancestors: ItemRow["ancestors"],
    cap: number,
  ) => {
    const listPath = `${parentPath}\u0000list`;
    const all = showAll.has(listPath) || search !== "";
    const shown = all ? entries : entries.slice(0, cap);
    for (const entry of shown) {
      pushItem(
        dim,
        entry,
        `${parentPath}\u0001${dim}\u0002${entry.key}`,
        depth,
        parentTotal,
        parentName,
        scope,
        ancestors,
        false,
      );
    }
    if (shown.length < entries.length) {
      rows.push({
        kind: "more",
        path: `${listPath}\u0000more`,
        depth,
        target: listPath,
        hiddenCount: entries.length - shown.length,
        noun: input.nounOf(dim, entries.length - shown.length),
        hiddenShare: restShare(entries, shown.length, parentTotal, metric),
      });
    } else if (all && entries.length > cap && search === "") {
      rows.push({ kind: "fewer", path: `${listPath}\u0000fewer`, depth, target: listPath });
    }
  };

  const top = ranked(dimension, facts, dimension === "project" ? input.favorites : undefined);
  // Coloured rows and favourites stay on top; the grey tail folds into Other.
  const isGrey = (key: string) => input.seriesOf(key) === OTHER_SERIES && !input.favorites.has(key);
  const grey = search === "" ? top.filter((entry) => isGrey(entry.key)) : [];
  const listed = grey.length > 1 ? top.filter((entry) => !isGrey(entry.key)) : top;
  const overall = dimension === "thread" ? "this project" : "the total";
  const topAll = showAll.has("\u0000top") || search !== "";
  const topShown = topAll ? listed : listed.slice(0, ROW_CAP);
  for (const entry of topShown) {
    pushItem(
      dimension,
      entry,
      `${dimension}\u0002${entry.key}`,
      0,
      whole,
      overall,
      facts,
      [],
      true,
    );
  }
  if (topShown.length < listed.length) {
    rows.push({
      kind: "more",
      path: "\u0000top\u0000more",
      depth: 0,
      target: "\u0000top",
      hiddenCount: listed.length - topShown.length,
      noun: input.nounOf(dimension, listed.length - topShown.length),
      hiddenShare: restShare(listed, topShown.length, whole, metric),
    });
  } else if (topAll && search === "" && listed.length > ROW_CAP) {
    rows.push({ kind: "fewer", path: "\u0000top\u0000fewer", depth: 0, target: "\u0000top" });
  }
  if (dimension === "thread") pushUnthreaded(facts, "\u0000none", 0, whole, overall);
  if (grey.length > 1) {
    const totals = grey.reduce((sum, entry) => addTotals(sum, entry.totals), emptyTotals());
    const otherOpen = open.has(OTHER_PATH);
    rows.push({
      kind: "other",
      path: OTHER_PATH,
      depth: 0,
      members: grey.map((entry) => entry.key),
      totals,
      share: share(totals, whole, metric),
      open: otherOpen,
      hidden: grey.every((entry) => input.hidden.has(entry.key)),
    });
    if (otherOpen) {
      const listPath = `${OTHER_PATH}\u0000list`;
      const otherAll = showAll.has(listPath);
      const otherShown = otherAll ? grey : grey.slice(0, ROW_CAP);
      for (const entry of otherShown) {
        pushItem(
          dimension,
          entry,
          `${dimension}\u0002${entry.key}`,
          1,
          whole,
          overall,
          facts,
          [],
          true,
        );
      }
      if (otherShown.length < grey.length) {
        rows.push({
          kind: "more",
          path: `${OTHER_PATH}\u0000more`,
          depth: 1,
          target: listPath,
          hiddenCount: grey.length - otherShown.length,
          noun: input.nounOf(dimension, grey.length - otherShown.length),
          hiddenShare: restShare(grey, otherShown.length, whole, metric),
        });
      } else if (otherAll && grey.length > ROW_CAP) {
        rows.push({ kind: "fewer", path: `${OTHER_PATH}\u0000fewer`, depth: 1, target: listPath });
      }
    }
  }
  return rows;
}

interface ScopeThreads {
  /** Totals per thread including everything nested under it. */
  readonly families: ReturnType<typeof familyTotals>;
  /** Each thread's own usage, without what it started. */
  readonly own: ReadonlyMap<string, UsageTotals>;
  readonly any: boolean;
}
