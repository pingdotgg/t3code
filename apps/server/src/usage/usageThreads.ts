/**
 * Pure grouping behind the thread drill-down: transcript records fold into
 * per-session groups, and session groups fold into thread rows using the
 * attribution the caller extracted from its own state (resume cursors and
 * dedicated worktrees).
 *
 * Pure, so grouping, de-duplication and attribution are testable without the
 * filesystem or the database.
 *
 * @module usageThreads
 */
import type {
  ProjectId,
  ThreadId,
  UsageAgentRow,
  UsageProviderKind,
  UsageThreadDayCost,
  UsageThreadRow,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { UsageDay } from "@t3tools/contracts";

import { makeDayFormatter, type ProjectAttribution } from "./usageAggregation.ts";
import { priceUsage, type RateTable } from "./usagePricing.ts";
import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";

/** How the caller identifies the transcript a record came from. */
export interface ThreadRecordContext {
  /** `provider:sessionId`, or a file-derived fallback when the id is empty. */
  readonly sessionKey: string;
  /** Claude subagent id when the record came from a `subagents/agent-*.jsonl` file. */
  readonly agentId: string | null;
}

interface MutableAgentSlice {
  totals: UsageTokenTotals;
  costUsd: number;
}

export interface SessionUsageGroup {
  readonly sessionKey: string;
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectId: ProjectId | null;
  readonly projectKey: string | null;
  readonly project: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly daily: ReadonlyMap<string, number>;
  readonly agents: ReadonlyMap<string, MutableAgentSlice>;
}

interface MutableSessionGroup {
  sessionKey: string;
  provider: UsageProviderKind;
  sessionId: string;
  cwd: string;
  projectId: ProjectId | null;
  projectKey: string | null;
  project: string;
  totals: UsageTokenTotals;
  costUsd: number;
  daily: Map<string, number>;
  agents: Map<string, MutableAgentSlice>;
}

export interface ThreadUsageOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
  readonly rates: RateTable;
  /** Same stable project resolver the summary uses. */
  readonly resolveProject?: (cwd: string) => ProjectAttribution | null;
}

/**
 * Folds records into per-session groups with per-day estimated costs.
 *
 * De-duplication is global across the scan with the same semantics as the
 * summary aggregator, so a thread's number here always reconciles with its
 * share of the summary.
 */
export class ThreadUsageAccumulator {
  readonly #groups = new Map<string, MutableSessionGroup>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #options: ThreadUsageOptions;

  constructor(options: ThreadUsageOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
  }

  add(record: UsageRecord, context: ThreadRecordContext): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) return false;
      this.#seen.add(record.dedupeKey);
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#options.sinceTimeMs !== undefined &&
      this.#options.untilTimeMs !== undefined &&
      (record.timestampMs < this.#options.sinceTimeMs ||
        record.timestampMs >= this.#options.untilTimeMs)
    ) {
      return false;
    }
    if (day < this.#options.sinceDay || day > this.#options.untilDay) return false;

    const resolvedProject = this.#options.resolveProject?.(record.cwd) ?? null;
    const projectKey =
      resolvedProject === null ? null : `id:${resolvedProject.projectId.replaceAll("\u0000", "")}`;
    const groupKey = JSON.stringify([context.sessionKey, record.cwd]);
    let group = this.#groups.get(groupKey);
    if (group === undefined) {
      group = {
        sessionKey: context.sessionKey,
        provider: record.provider,
        sessionId: record.sessionId,
        cwd: record.cwd,
        projectId: resolvedProject?.projectId ?? null,
        projectKey,
        project: resolvedProject?.title ?? "",
        totals: EMPTY_TOTALS,
        costUsd: 0,
        daily: new Map(),
        agents: new Map(),
      };
      this.#groups.set(groupKey, group);
    }

    const priced = priceUsage(
      this.#options.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
    );
    group.totals = addTotals(group.totals, record.totals);
    group.costUsd += priced.costUsd;
    group.daily.set(day, (group.daily.get(day) ?? 0) + priced.costUsd);

    if (context.agentId !== null) {
      let agent = group.agents.get(context.agentId);
      if (agent === undefined) {
        agent = { totals: EMPTY_TOTALS, costUsd: 0 };
        group.agents.set(context.agentId, agent);
      }
      agent.totals = addTotals(agent.totals, record.totals);
      agent.costUsd += priced.costUsd;
    }
    return true;
  }

  finish(): readonly SessionUsageGroup[] {
    return [...this.#groups.values()].map((group) => ({
      sessionKey: group.sessionKey,
      provider: group.provider,
      sessionId: group.sessionId,
      cwd: group.cwd,
      projectId: group.projectId,
      projectKey: group.projectKey,
      project: group.project,
      totals: group.totals,
      costUsd: group.costUsd,
      daily: group.daily,
      agents: group.agents,
    }));
  }
}

/** A thread a session can attribute to, from the environment's own state. */
export interface ThreadRef {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface ThreadAttribution {
  /** `provider:sessionId` of each thread's current session, from resume cursors. */
  readonly sessionToThread: ReadonlyMap<string, ThreadRef>;
  /**
   * Dedicated worktree path → thread. Only paths claimed by exactly one
   * thread belong here: a shared root would stamp one thread's identity onto
   * every unrelated session running there.
   */
  readonly worktreeToThread: ReadonlyMap<string, ThreadRef>;
}

export interface FoldThreadRowsOptions {
  /** A title, `null` for outside-projects sessions, `undefined` for no filter. */
  readonly projectFilter?: string | null | undefined;
  /** Maximum returned rows, including grouped remainders. */
  readonly cap: number;
}

interface MutableThreadRow {
  threadId: ThreadId | null;
  title: string | null;
  provider: UsageProviderKind;
  project: string;
  projectId: ProjectId | null;
  projectKey: string | null;
  cwd: string;
  totals: UsageTokenTotals;
  costUsd: number;
  sessionKeys: Set<string>;
  groupedRows: number;
  daily: Map<string, number>;
  agents: Map<string, MutableAgentSlice>;
  /** Session whose transcript can supply a title when no thread claims the row. */
  titleSessionKey: string;
}

export interface FoldedThreadRows {
  readonly rows: readonly (Omit<UsageThreadRow, "title"> & {
    readonly title: string | null;
    readonly titleSessionKey: string;
  })[];
  readonly truncatedRows: number;
}

function addDailyCosts(target: Map<string, number>, source: ReadonlyMap<string, number>): void {
  for (const [day, costUsd] of source) {
    target.set(day, (target.get(day) ?? 0) + costUsd);
  }
}

/**
 * Groups sessions into thread rows: resume-cursor matches first, then unique
 * worktrees, else one row per session. Rows sort by cost. Rows beyond the cap
 * fold into provider/project-specific remainders so the returned hierarchy
 * still reconciles. A `null` title marks retained rows whose name must come
 * from the transcript.
 */
export function foldThreadRows(
  groups: readonly SessionUsageGroup[],
  attribution: ThreadAttribution,
  options: FoldThreadRowsOptions,
): FoldedThreadRows {
  const byKey = new Map<string, MutableThreadRow>();

  for (const group of groups) {
    if (options.projectFilter !== undefined && group.projectKey !== options.projectFilter) continue;

    const ref =
      attribution.sessionToThread.get(group.sessionKey) ??
      (group.cwd.length > 0 ? attribution.worktreeToThread.get(group.cwd) : undefined);
    const rowKey =
      ref === undefined
        ? JSON.stringify(["session", group.provider, group.projectKey, group.sessionKey])
        : JSON.stringify(["thread", group.provider, group.projectKey, ref.threadId]);

    let row = byKey.get(rowKey);
    if (row === undefined) {
      row = {
        threadId: ref?.threadId ?? null,
        title: ref?.title ?? null,
        provider: group.provider,
        project: group.project,
        projectId: group.projectId,
        projectKey: group.projectKey,
        cwd: group.cwd,
        totals: EMPTY_TOTALS,
        costUsd: 0,
        sessionKeys: new Set(),
        groupedRows: 0,
        daily: new Map(),
        agents: new Map(),
        titleSessionKey: group.sessionKey,
      };
      byKey.set(rowKey, row);
    }

    row.totals = addTotals(row.totals, group.totals);
    row.costUsd += group.costUsd;
    row.sessionKeys.add(group.sessionKey);
    addDailyCosts(row.daily, group.daily);
    for (const [agentId, slice] of group.agents) {
      let agent = row.agents.get(agentId);
      if (agent === undefined) {
        agent = { totals: EMPTY_TOTALS, costUsd: 0 };
        row.agents.set(agentId, agent);
      }
      agent.totals = addTotals(agent.totals, slice.totals);
      agent.costUsd += slice.costUsd;
    }
  }

  const sorted = [...byKey.entries()].sort(
    (a, b) =>
      b[1].costUsd - a[1].costUsd ||
      totalOf(b[1].totals) - totalOf(a[1].totals) ||
      a[0].localeCompare(b[0]),
  );
  let keptCount = Math.min(sorted.length, options.cap);
  const projectScopeCount = (rows: typeof sorted): number =>
    new Set(rows.map(([, row]) => JSON.stringify([row.provider, row.projectKey]))).size;
  while (keptCount > 0 && keptCount + projectScopeCount(sorted.slice(keptCount)) > options.cap) {
    keptCount -= 1;
  }

  let kept = sorted.slice(0, keptCount);
  let omitted = sorted.slice(keptCount);
  let remainderScope: "project" | "provider" = "project";
  if (projectScopeCount(omitted) > options.cap) {
    // More project scopes than the response can represent. Collapse all named
    // rows and preserve provider totals in provider-wide overflow rows.
    kept = [];
    omitted = sorted;
    remainderScope = "provider";
    const providerCount = new Set(omitted.map(([, row]) => row.provider)).size;
    if (providerCount > options.cap) {
      throw new RangeError("Thread row cap must fit one remainder per provider");
    }
  }

  const remainders = new Map<string, MutableThreadRow>();
  for (const [, omittedRow] of omitted) {
    const scopeKey = JSON.stringify([
      omittedRow.provider,
      remainderScope === "project" ? omittedRow.projectKey : null,
    ]);
    let remainder = remainders.get(scopeKey);
    if (remainder === undefined) {
      const key = `remainder:${scopeKey}`;
      remainder = {
        threadId: null,
        title: null,
        provider: omittedRow.provider,
        project: remainderScope === "project" ? omittedRow.project : "",
        projectId: remainderScope === "project" ? omittedRow.projectId : null,
        projectKey: remainderScope === "project" ? omittedRow.projectKey : null,
        cwd: "",
        totals: EMPTY_TOTALS,
        costUsd: 0,
        sessionKeys: new Set(),
        groupedRows: 0,
        daily: new Map(),
        agents: new Map(),
        titleSessionKey: key,
      };
      remainders.set(scopeKey, remainder);
    }
    remainder.groupedRows += 1;
    remainder.totals = addTotals(remainder.totals, omittedRow.totals);
    remainder.costUsd += omittedRow.costUsd;
    for (const sessionKey of omittedRow.sessionKeys) remainder.sessionKeys.add(sessionKey);
    addDailyCosts(remainder.daily, omittedRow.daily);
    for (const [agentId, slice] of omittedRow.agents) {
      let agent = remainder.agents.get(agentId);
      if (agent === undefined) {
        agent = { totals: EMPTY_TOTALS, costUsd: 0 };
        remainder.agents.set(agentId, agent);
      }
      agent.totals = addTotals(agent.totals, slice.totals);
      agent.costUsd += slice.costUsd;
    }
  }

  const displayed = [
    ...kept,
    ...[...remainders.entries()].map(([scopeKey, remainder]) => {
      remainder.title = `Other threads (${remainder.groupedRows})`;
      return [`remainder:${scopeKey}`, remainder] as const;
    }),
  ].sort(
    (a, b) =>
      b[1].costUsd - a[1].costUsd ||
      totalOf(b[1].totals) - totalOf(a[1].totals) ||
      a[0].localeCompare(b[0]),
  );

  return {
    rows: displayed.map(([key, row]) => ({
      key,
      threadId: row.threadId,
      title: row.title,
      titleSessionKey: row.titleSessionKey,
      provider: row.provider,
      ...(row.projectId === null ? {} : { projectId: row.projectId }),
      ...(row.project === "" ? {} : { project: row.project }),
      totals: row.totals,
      costUsd: row.costUsd,
      sessions: row.sessionKeys.size,
      ...(row.groupedRows === 0 ? {} : { groupedRows: row.groupedRows }),
      agents: [...row.agents.entries()]
        .map(([agentId, slice]) => ({
          agentId,
          totals: slice.totals,
          costUsd: slice.costUsd,
        }))
        .sort((a, b) => b.costUsd - a.costUsd) satisfies UsageAgentRow[],
      daily: [...row.daily.entries()]
        .map(([day, costUsd]) => ({
          day: day as UsageDay,
          costUsd,
        }))
        .sort((a, b) => a.day.localeCompare(b.day)) satisfies UsageThreadDayCost[],
    })),
    truncatedRows: omitted.length,
  };
}

function totalOf(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}
