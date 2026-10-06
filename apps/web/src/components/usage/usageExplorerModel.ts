/**
 * The Usage page's data model: flat usage facts, folded by whichever
 * dimension the page is grouped by. Pure functions only, so the chart, the
 * breakdown table and the provider list all read the same totals.
 */
import type { UsageBucket, UsageProject, UsageProviderKind, UsageThread } from "@t3tools/contracts";

export type UsageDimension = "project" | "provider" | "model" | "environment" | "thread";
export type UsageExplorerMetric = "cost" | "tokens";

/** Project key for usage whose working directory is not inside any project. */
export const OUTSIDE_PROJECTS = "\u0000outside";
/** Project key for usage the server could not place (older servers, Cursor). */
export const UNKNOWN_PROJECT = "\u0000unknown";
/** Series key for the stacked tail beyond the coloured top series. */
export const OTHER_SERIES = "\u0000other";

/** Separates the parts of a composite key (provider and model, for one). */
const KEY_SEP = "\u001f";

/** One cell of usage after environment merging, with every dimension resolved. */
export interface UsageFact {
  /** `YYYY-MM-DD` for daily data, otherwise the UTC hour start. */
  readonly time: string;
  /** Environment whose scan this usage came from. */
  readonly environment: string;
  readonly provider: UsageProviderKind;
  /**
   * Environment and provider instance (see {@link accountKey}); the provider
   * kind stands in for the instance when the server did not say.
   */
  readonly account: string;
  readonly model: string;
  readonly project: string;
  /** Thread key from the thread index, or null when the server sent no threads. */
  readonly thread: string | null;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  readonly costUsd: number;
  /** Cost by token type; a share of cost may stay unsplit. */
  readonly inputUsd: number;
  readonly cacheReadUsd: number;
  readonly cacheWriteUsd: number;
  readonly outputUsd: number;
  readonly fastUsd: number;
  readonly ultrafastUsd: number;
  readonly premiumUsd: number;
  readonly cacheSavingsUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
}

export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  fastUsd: number;
  ultrafastUsd: number;
  premiumUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
}

export function emptyTotals(): UsageTotals {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    inputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    fastUsd: 0,
    ultrafastUsd: 0,
    premiumUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    unpricedRecords: 0,
  };
}

export function addTotals(into: UsageTotals, from: UsageTotals | UsageFact): UsageTotals {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.costUsd += from.costUsd;
  into.inputUsd += from.inputUsd;
  into.cacheReadUsd += from.cacheReadUsd;
  into.cacheWriteUsd += from.cacheWriteUsd;
  into.outputUsd += from.outputUsd;
  into.fastUsd += from.fastUsd;
  into.ultrafastUsd += from.ultrafastUsd;
  into.premiumUsd += from.premiumUsd;
  into.cacheSavingsUsd += from.cacheSavingsUsd;
  into.records += from.records;
  into.unpricedRecords += from.unpricedRecords;
  return into;
}

/** Processed tokens. Reasoning is part of output and is not added again. */
export const tokensOf = (totals: UsageTotals): number =>
  totals.input + totals.cacheRead + totals.cacheWrite + totals.output;

export const metricOf = (totals: UsageTotals | undefined, metric: UsageExplorerMetric): number =>
  totals === undefined ? 0 : metric === "cost" ? totals.costUsd : tokensOf(totals);

/** Tokens with no known price: counted in tokens, absent from cost. */
export const isUnpriced = (totals: UsageTotals): boolean =>
  totals.costUsd === 0 && tokensOf(totals) > 0 && totals.unpricedRecords > 0;

export function sumFacts(facts: Iterable<UsageFact>): UsageTotals {
  const totals = emptyTotals();
  for (const fact of facts) addTotals(totals, fact);
  return totals;
}

export function foldFacts(
  facts: Iterable<UsageFact>,
  keyOf: (fact: UsageFact) => string | null,
): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  for (const fact of facts) {
    const key = keyOf(fact);
    if (key === null) continue;
    let totals = out.get(key);
    if (totals === undefined) {
      totals = emptyTotals();
      out.set(key, totals);
    }
    addTotals(totals, fact);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                    */
/* -------------------------------------------------------------------------- */

export interface UsageThreadInfo {
  readonly key: string;
  readonly title: string | null;
  readonly project: string;
  readonly provider: UsageProviderKind | null;
  /** Thread that started this one, by key. */
  readonly parent: string | null;
  /** T3 thread this usage belongs to, when it ran in T3. */
  readonly t3: { readonly environmentId: string; readonly threadId: string } | null;
  /** Native sub-agent inside a provider session, rather than a thread of its own. */
  readonly agent: boolean;
}

/**
 * Parent links for nesting. A sub-agent nests under the thread that started
 * it only within the same project, and malformed lineage that loops is cut at
 * its first member so every thread still reaches a shown root.
 */
export interface ThreadTree {
  readonly info: ReadonlyMap<string, UsageThreadInfo>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly rootOf: (key: string) => string;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
}

function buildThreadTree(threads: Iterable<UsageThreadInfo>): ThreadTree {
  const info = new Map<string, UsageThreadInfo>();
  for (const thread of threads) info.set(thread.key, thread);
  const parentOf = new Map<string, string>();
  for (const thread of info.values()) {
    const parent = thread.parent === null ? undefined : info.get(thread.parent);
    if (parent !== undefined && parent.key !== thread.key && parent.project === thread.project) {
      parentOf.set(thread.key, parent.key);
    }
  }
  const done = new Set<string>();
  for (const start of info.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let key: string | undefined = start;
    while (key !== undefined && !done.has(key) && !onPath.has(key)) {
      onPath.add(key);
      path.push(key);
      key = parentOf.get(key);
    }
    if (key !== undefined && onPath.has(key)) parentOf.delete(key);
    for (const visited of path) done.add(visited);
  }
  const roots = new Map<string, string>();
  const rootOf = (key: string): string => {
    const cached = roots.get(key);
    if (cached !== undefined) return cached;
    let root = key;
    for (let up = parentOf.get(root); up !== undefined; up = parentOf.get(root)) root = up;
    roots.set(key, root);
    return root;
  };
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent);
    if (list === undefined) childrenOf.set(parent, [child]);
    else list.push(child);
  }
  return { info, parentOf, rootOf, childrenOf };
}

/** Totals per thread including every thread nested under it. */
export function familyTotals(
  facts: Iterable<UsageFact>,
  tree: ThreadTree,
): Map<string, UsageTotals & { descendants: number }> {
  const out = new Map<string, UsageTotals & { descendants: number }>();
  const at = (key: string) => {
    let totals = out.get(key);
    if (totals === undefined) {
      totals = { ...emptyTotals(), descendants: 0 };
      out.set(key, totals);
    }
    return totals;
  };
  for (const [key, own] of foldFacts(facts, (fact) => fact.thread)) {
    addTotals(at(key), own);
    for (let up = tree.parentOf.get(key); up !== undefined; up = tree.parentOf.get(up)) {
      const ancestor = at(up);
      addTotals(ancestor, own);
      ancestor.descendants += 1;
    }
  }
  return out;
}

/**
 * Whether a thread spent an unusual share of its own cost writing the prompt
 * cache. A typical thread sits near a third; this flags the top few percent.
 */
export const isCacheHeavy = (own: UsageTotals | undefined): boolean =>
  own !== undefined &&
  own.costUsd >= 2 &&
  own.records >= 30 &&
  own.cacheWriteUsd / own.costUsd >= 0.5;

/* -------------------------------------------------------------------------- */
/* Series and colours                                                         */
/* -------------------------------------------------------------------------- */

export const SERIES_PALETTE = [
  "#5b8ff9",
  "#61d9a8",
  "#f6bd16",
  "#e8684a",
  "#9270ca",
  "#6dc8ec",
  "#ff9d4d",
  "#5d7092",
] as const;
const OTHER_COLOR = "var(--muted-foreground)";

export interface UsageSeries {
  readonly key: string;
  readonly color: string;
  /** Item keys stacked in this series; one for a top item, many for Other. */
  readonly members: readonly string[];
}

const byCostThenTokens = (a: [string, UsageTotals], b: [string, UsageTotals]) =>
  b[1].costUsd - a[1].costUsd || tokensOf(b[1]) - tokensOf(a[1]) || a[0].localeCompare(b[0]);

/**
 * Colours that stay put across windows, zoom and metric: palette slots go to
 * the biggest items by cost over all loaded history. An item outside that set
 * borrows a free slot, in rank order, while it is among the shown series.
 */
function stableColors(
  allTimeByKey: ReadonlyMap<string, UsageTotals>,
  keys: readonly string[],
  fixedColor?: (key: string) => string | undefined,
): Map<string, string> {
  const rank = [...allTimeByKey].sort(byCostThenTokens).map(([key]) => key);
  const fixed = new Map(
    rank.slice(0, SERIES_PALETTE.length).map((key, i) => [key, SERIES_PALETTE[i]!]),
  );
  const used = new Set(keys.map((key) => fixed.get(key)).filter((color) => color !== undefined));
  const free = SERIES_PALETTE.filter((color) => !used.has(color));
  const position = new Map(rank.map((key, i) => [key, i]));
  const out = new Map<string, string>();
  for (const key of keys) {
    const color = fixedColor?.(key) ?? fixed.get(key);
    if (color !== undefined) out.set(key, color);
  }
  const borrowers = keys
    .filter((key) => !out.has(key))
    .sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity));
  for (const key of borrowers) out.set(key, free.shift() ?? OTHER_COLOR);
  return out;
}

/** The top items by the metric get their own colour; the tail stacks as Other. */
export function buildSeries(
  totalsByKey: ReadonlyMap<string, UsageTotals>,
  allTimeByKey: ReadonlyMap<string, UsageTotals>,
  metric: UsageExplorerMetric,
  fixedColor?: (key: string) => string | undefined,
): {
  readonly series: readonly UsageSeries[];
  readonly seriesOf: (key: string) => string;
  readonly colorOf: (key: string) => string;
} {
  const ranked = [...totalsByKey]
    .map(([key, totals]) => ({ key, value: metricOf(totals, metric) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const top = ranked.slice(0, SERIES_PALETTE.length);
  const rest = ranked.slice(SERIES_PALETTE.length);
  const colors = stableColors(
    allTimeByKey,
    top.map((entry) => entry.key),
    fixedColor,
  );
  const series: UsageSeries[] = top.map((entry) => ({
    key: entry.key,
    color: colors.get(entry.key) ?? OTHER_COLOR,
    members: [entry.key],
  }));
  if (rest.length > 0) {
    series.push({ key: OTHER_SERIES, color: OTHER_COLOR, members: rest.map((entry) => entry.key) });
  }
  const topKeys = new Set(top.map((entry) => entry.key));
  const seriesOf = (key: string) => (topKeys.has(key) ? key : OTHER_SERIES);
  const colorOf = (key: string) => colors.get(key) ?? OTHER_COLOR;
  return { series, seriesOf, colorOf };
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

export type BinMinutes = 60 | 360 | 1440;

/** Interval that keeps a readable number of points for a window's length. */
export function autoBinMinutes(spanHours: number): BinMinutes {
  return spanHours <= 48 ? 60 : spanHours <= 10 * 24 ? 360 : 1440;
}

const localPartsFormatters = new Map<string, Intl.DateTimeFormat>();
function localParts(instant: string, timeZone: string): { day: string; hour: number } {
  let format = localPartsFormatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    localPartsFormatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/**
 * Key of the chart interval a fact falls in. Hourly facts carry UTC hour
 * starts; multi-hour intervals align to the local clock (midnight, 6am...).
 */
export function binKey(time: string, binMinutes: BinMinutes, timeZone: string): string {
  if (time.length === 10) return time;
  if (binMinutes === 60) return time;
  const { day, hour } = localParts(time, timeZone);
  if (binMinutes === 1440) return day;
  return `${day}T${String(Math.floor(hour / 6) * 6).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Share as a percentage, with `<0.1%` for small positive shares. */
export function formatShare(share: number, digits = 1): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const floor = 10 ** -digits;
  if (share * 100 < floor / 2) return `<${floor}%`;
  return `${(share * 100).toFixed(digits)}%`;
}

/** Titles often start with an absolute home path; show it as `~`. */
export const tidyTitle = (text: string): string =>
  text.replace(/\/(?:Users|home)\/[^/\s]+\//g, "~/");

/**
 * Rows as CSV. Text that a spreadsheet would read as a formula gets a leading
 * quote, and fields with commas, quotes or line breaks are quoted.
 */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number) => {
    if (typeof value === "number") return String(value);
    const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/* From merged summaries                                                      */
/* -------------------------------------------------------------------------- */

/** One environment's buckets with the threads and projects they point at. */
export interface UsageExplorerSource {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly buckets: readonly UsageBucket[];
  readonly threads: readonly UsageThread[];
  readonly projects: readonly UsageProject[];
}

export interface UsageExplorerData {
  readonly facts: readonly UsageFact[];
  readonly threads: ThreadTree;
  /** Project names, with the environment added where two share a title. */
  readonly projectNames: ReadonlyMap<string, string>;
  /** Project titles alone, for views inside one environment. */
  readonly projectTitles: ReadonlyMap<string, string>;
  /** Whether any environment split its usage by thread. */
  readonly hasThreads: boolean;
}

/** Thread keys use the server's stable key, so they mean the same thread in every window. */
const threadKey = (environmentId: string, thread: UsageThread) =>
  `${environmentId}${KEY_SEP}${thread.key}`;
/** Accounts are provider instances, which belong to one environment. */
const accountKey = (environmentId: string, instance: string) =>
  `${environmentId}${KEY_SEP}${instance}`;
export const splitAccountKey = (key: string): { environmentId: string; instance: string } => {
  const index = key.indexOf(KEY_SEP);
  return { environmentId: key.slice(0, index), instance: key.slice(index + 1) };
};
const projectKey = (environmentId: string, projectId: string) =>
  `${environmentId}${KEY_SEP}${projectId}`;

/**
 * Flattens merged buckets into facts with every dimension resolved. Project
 * and thread keys carry their environment: ids are only unique within one.
 */
export function buildExplorerData(sources: readonly UsageExplorerSource[]): UsageExplorerData {
  const facts: UsageFact[] = [];
  const infos: UsageThreadInfo[] = [];
  const projectNames = new Map<string, string>();
  const projectTitles = new Map<string, string>();
  const titleCount = new Map<string, number>();
  for (const source of sources) {
    for (const project of source.projects) {
      titleCount.set(project.title, (titleCount.get(project.title) ?? 0) + 1);
    }
  }
  let hasThreads = false;
  for (const source of sources) {
    for (const project of source.projects) {
      // Two environments can each have a project with the same name.
      const name =
        (titleCount.get(project.title) ?? 0) > 1
          ? `${project.title} · ${source.environmentLabel}`
          : project.title;
      projectNames.set(projectKey(source.environmentId, project.projectId), name);
      projectTitles.set(projectKey(source.environmentId, project.projectId), project.title);
    }
    const projectOf = (thread: UsageThread | undefined) =>
      thread === undefined
        ? UNKNOWN_PROJECT
        : thread.projectId !== undefined
          ? projectKey(source.environmentId, thread.projectId)
          : thread.located
            ? OUTSIDE_PROJECTS
            : UNKNOWN_PROJECT;
    for (const thread of source.threads) {
      hasThreads = true;
      const parent = thread.parent === undefined ? undefined : source.threads[thread.parent];
      infos.push({
        key: threadKey(source.environmentId, thread),
        title: thread.title ?? null,
        project: projectOf(thread),
        provider: null,
        parent: parent === undefined ? null : threadKey(source.environmentId, parent),
        t3:
          thread.threadId === undefined
            ? null
            : { environmentId: source.environmentId, threadId: thread.threadId },
        agent: thread.subagent === true,
      });
    }
    for (const bucket of source.buckets) {
      const thread = bucket.thread === undefined ? undefined : source.threads[bucket.thread];
      facts.push({
        time: bucket.hourStart ?? bucket.day,
        environment: source.environmentId,
        provider: bucket.provider,
        account: accountKey(source.environmentId, bucket.instanceId ?? bucket.provider),
        model: bucket.model,
        project: projectOf(thread),
        thread: thread === undefined ? null : threadKey(source.environmentId, thread),
        input: bucket.totals.uncachedInputTokens,
        cacheRead: bucket.totals.cachedInputTokens,
        cacheWrite: bucket.totals.cacheCreationTokens,
        output: bucket.totals.outputTokens,
        reasoning: bucket.totals.reasoningTokens,
        costUsd: bucket.costUsd,
        inputUsd: bucket.categoryCostUsd?.input ?? 0,
        cacheReadUsd: bucket.categoryCostUsd?.cacheRead ?? 0,
        cacheWriteUsd: bucket.categoryCostUsd?.cacheWrite ?? 0,
        outputUsd: bucket.categoryCostUsd?.output ?? 0,
        fastUsd: bucket.fastCostUsd ?? 0,
        ultrafastUsd: bucket.ultrafastCostUsd ?? 0,
        premiumUsd: bucket.speedPremiumUsd ?? 0,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
      });
    }
  }
  // A thread's provider is whichever wrote most of its tokens.
  const providerByThread = new Map<string, Map<UsageProviderKind, number>>();
  for (const fact of facts) {
    if (fact.thread === null) continue;
    const counts = providerByThread.get(fact.thread) ?? new Map<UsageProviderKind, number>();
    counts.set(fact.provider, (counts.get(fact.provider) ?? 0) + tokensOf(fact));
    providerByThread.set(fact.thread, counts);
  }
  const threads = buildThreadTree(
    infos.map((info) => {
      const counts = providerByThread.get(info.key);
      if (counts === undefined) return info;
      const provider = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return { ...info, provider };
    }),
  );
  return { facts, threads, projectNames, projectTitles, hasThreads };
}

/* -------------------------------------------------------------------------- */
/* Dimensions and filters                                                     */
/* -------------------------------------------------------------------------- */

export const modelKey = (provider: string, model: string) => `${provider}${KEY_SEP}${model}`;
export const splitModelKey = (key: string): { provider: string; model: string } => {
  const index = key.indexOf(KEY_SEP);
  return { provider: key.slice(0, index), model: key.slice(index + 1) };
};

/** The key a fact folds under in a dimension. A thread row carries its whole family. */
export function keyFor(
  dimension: UsageDimension | "account",
  fact: UsageFact,
  tree: ThreadTree,
): string | null {
  switch (dimension) {
    case "project":
      return fact.project;
    case "provider":
      return fact.provider;
    case "account":
      return fact.account;
    case "model":
      return modelKey(fact.provider, fact.model);
    case "environment":
      return fact.environment;
    case "thread":
      return fact.thread === null ? null : tree.rootOf(fact.thread);
  }
}

export interface UsageFilters {
  /** Accounts to include; null means every account. */
  readonly accounts: ReadonlySet<string> | null;
  readonly environment: string | null;
  readonly project: string | null;
  readonly model: string | null;
}

export function matchesFilters(fact: UsageFact, filters: UsageFilters): boolean {
  return (
    (filters.accounts === null || filters.accounts.has(fact.account)) &&
    (filters.environment === null || fact.environment === filters.environment) &&
    (filters.project === null || fact.project === filters.project) &&
    (filters.model === null || modelKey(fact.provider, fact.model) === filters.model)
  );
}

/** The dimension an expanded row lists under it. */
export function childDimension(
  dimension: UsageDimension | "account",
  accountsOfProvider: number,
): UsageDimension | "account" | null {
  switch (dimension) {
    case "provider":
      return accountsOfProvider > 1 ? "account" : "model";
    case "account":
      return "model";
    case "model":
    case "environment":
      return "project";
    case "project":
      return "thread";
    case "thread":
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Columns and sorting                                                        */
/* -------------------------------------------------------------------------- */

export type UsageColumnId =
  | "cost"
  | "share"
  | "tokens"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "cacheWriteCost"
  | "cached"
  | "change";

export const USAGE_COLUMNS: readonly {
  readonly id: UsageColumnId;
  readonly label: string;
  readonly description?: string;
}[] = [
  { id: "cost", label: "Cost" },
  { id: "share", label: "Share" },
  { id: "tokens", label: "Tokens", description: "Input, cache reads, cache writes and output" },
  { id: "input", label: "Input", description: "Uncached input tokens" },
  { id: "output", label: "Output", description: "Output tokens, including reasoning" },
  { id: "cacheRead", label: "Cache reads", description: "Input tokens served from cache" },
  { id: "cacheWrite", label: "Cache writes", description: "Tokens written to the prompt cache" },
  {
    id: "cacheWriteCost",
    label: "Cache write cost",
    description: "Estimated cost of writing the prompt cache",
  },
  { id: "cached", label: "Cached %", description: "Share of input served from cache" },
  {
    id: "change",
    label: "Change",
    description: "Up or down against the same length of time just before",
  },
];

export const DEFAULT_COLUMNS: readonly UsageColumnId[] = ["cost", "share", "tokens"];

export const cachedShare = (totals: UsageTotals): number | null => {
  const input = totals.input + totals.cacheRead + totals.cacheWrite;
  return input === 0 ? null : totals.cacheRead / input;
};

export interface UsageSort {
  readonly column: UsageColumnId | "name";
  readonly descending: boolean;
}

function sortValue(
  column: UsageSort["column"],
  totals: UsageTotals,
  metric: UsageExplorerMetric,
  name: string,
  previous?: UsageTotals,
): number | string {
  switch (column) {
    case "name":
      return name.toLowerCase();
    case "cost":
      return totals.costUsd;
    case "share":
      return metricOf(totals, metric);
    case "tokens":
      return tokensOf(totals);
    case "input":
      return totals.input;
    case "output":
      return totals.output;
    case "cacheRead":
      return totals.cacheRead;
    case "cacheWrite":
      return totals.cacheWrite;
    case "cacheWriteCost":
      return totals.cacheWriteUsd;
    case "cached":
      return cachedShare(totals) ?? 0;
    case "change":
      return metricOf(totals, metric) - metricOf(previous, metric);
  }
}

export interface RankedEntry {
  readonly key: string;
  readonly totals: UsageTotals;
}

/**
 * Rows with any usage, pinned keys first, then by the chosen column. Ties
 * and the default order fall back to the metric, biggest first.
 */
export function rankEntries(
  totalsByKey: ReadonlyMap<string, UsageTotals>,
  options: {
    readonly metric: UsageExplorerMetric;
    readonly sort: UsageSort | null;
    readonly nameOf: (key: string) => string;
    readonly pinned?: ReadonlySet<string>;
    readonly previous?: ReadonlyMap<string, UsageTotals>;
  },
): RankedEntry[] {
  const { metric, sort, nameOf, pinned, previous } = options;
  return [...totalsByKey]
    .filter(([, totals]) => tokensOf(totals) > 0 || totals.costUsd > 0)
    .map(([key, totals]) => ({ key, totals }))
    .sort((a, b) => {
      const pin = Number(pinned?.has(b.key) ?? false) - Number(pinned?.has(a.key) ?? false);
      if (pin !== 0) return pin;
      if (sort !== null) {
        const x = sortValue(sort.column, a.totals, metric, nameOf(a.key), previous?.get(a.key));
        const y = sortValue(sort.column, b.totals, metric, nameOf(b.key), previous?.get(b.key));
        const compared =
          typeof x === "string" && typeof y === "string"
            ? x.localeCompare(y)
            : Number(x) - Number(y);
        if (compared !== 0) return sort.descending ? -compared : compared;
      }
      return metricOf(b.totals, metric) - metricOf(a.totals, metric) || a.key.localeCompare(b.key);
    });
}

/** Case-insensitive match on every word of the query, in any order. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/* -------------------------------------------------------------------------- */
/* Chart                                                                      */
/* -------------------------------------------------------------------------- */

export interface ChartColumn {
  readonly bin: string;
  /** Per series, in series order. */
  readonly values: readonly number[];
  readonly total: number;
  /** The interval's own total, which differs from `total` in a running chart. */
  readonly own: number;
}

/** Interval keys covering a window, oldest first. */
export function timelineBins(
  window: { readonly days: readonly string[]; readonly hours: readonly string[] },
  binMinutes: BinMinutes,
  timeZone: string,
): readonly string[] {
  if (window.hours.length === 0) return window.days;
  const bins: string[] = [];
  for (const hour of window.hours) {
    const bin = binKey(hour, binMinutes, timeZone);
    if (bins[bins.length - 1] !== bin) bins.push(bin);
  }
  return bins;
}

export function chartColumns(input: {
  readonly facts: readonly UsageFact[];
  readonly bins: readonly string[];
  readonly series: readonly UsageSeries[];
  readonly seriesOf: (fact: UsageFact) => string | null;
  readonly binOf: (fact: UsageFact) => string;
  readonly metric: UsageExplorerMetric;
  readonly running: boolean;
}): readonly ChartColumn[] {
  const { facts, bins, series, seriesOf, binOf, metric, running } = input;
  const binIndex = new Map(bins.map((bin, index) => [bin, index]));
  const seriesIndex = new Map(series.map((entry, index) => [entry.key, index]));
  const grid = bins.map(() => series.map(() => 0));
  for (const fact of facts) {
    const row = binIndex.get(binOf(fact));
    const key = seriesOf(fact);
    const column = key === null ? undefined : seriesIndex.get(key);
    if (row === undefined || column === undefined) continue;
    grid[row]![column]! += metric === "cost" ? fact.costUsd : tokensOf(fact);
  }
  const columns: ChartColumn[] = [];
  let carried = series.map(() => 0);
  for (const [index, values] of grid.entries()) {
    const own = values.reduce((sum, value) => sum + value, 0);
    const shown = running ? values.map((value, i) => value + carried[i]!) : values;
    if (running) carried = shown;
    columns.push({
      bin: bins[index]!,
      values: shown,
      total: shown.reduce((sum, value) => sum + value, 0),
      own,
    });
  }
  return columns;
}

/** Cost by token type, in the shape the share bars take. */
export function categoryCostOf(totals: UsageTotals) {
  const split = totals.inputUsd + totals.cacheReadUsd + totals.cacheWriteUsd + totals.outputUsd;
  return {
    input: totals.inputUsd,
    cacheRead: totals.cacheReadUsd,
    cacheWrite: totals.cacheWriteUsd,
    output: totals.outputUsd,
    unsplit: Math.max(0, totals.costUsd - split),
  };
}

export function speedCostOf(totals: UsageTotals) {
  return {
    standard: Math.max(0, totals.costUsd - totals.fastUsd - totals.ultrafastUsd),
    fast: totals.fastUsd,
    ultrafast: totals.ultrafastUsd,
    premium: totals.premiumUsd,
  };
}
