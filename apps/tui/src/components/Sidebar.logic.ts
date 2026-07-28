import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import type { OrchestrationShellSnapshot } from "../connection.ts";

export const SIDEBAR_SNOOZED_SECTION_ID = "sidebar-v2:snoozed";
export const SIDEBAR_SETTLED_SECTION_ID = "sidebar-v2:settled";
export const SIDEBAR_SETTLED_INITIAL_COUNT = 10;

export type SidebarSection = "active" | "snoozed" | "settled";

export type Selection =
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "section"; readonly id: string }
  | { readonly kind: "more"; readonly id: string };

export type Row =
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly thread: OrchestrationThreadShell;
      readonly section: SidebarSection;
      readonly projectTitle: string;
      readonly timestamp: string;
    }
  | {
      readonly kind: "section";
      readonly id: string;
      readonly section: Exclude<SidebarSection, "active">;
      readonly title: string;
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "more";
      readonly id: string;
      readonly section: "settled";
      readonly hiddenCount: number;
    };

export function selectionEquals(selection: Selection | null, row: Row): boolean {
  return selection !== null && selection.kind === row.kind && selection.id === row.id;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function activeOrder(left: OrchestrationThreadShell, right: OrchestrationThreadShell): number {
  return (
    timestampMs(right.createdAt) - timestampMs(left.createdAt) || left.id.localeCompare(right.id)
  );
}

export function settledTimestamp(thread: OrchestrationThreadShell): string {
  if (timestampMs(thread.settledAt) > 0) return thread.settledAt!;
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    thread.updatedAt,
  ];
  let latest = thread.updatedAt;
  for (const candidate of candidates) {
    if (timestampMs(candidate) > timestampMs(latest)) latest = candidate ?? latest;
  }
  return latest;
}

function selectedThread(
  threads: readonly OrchestrationThreadShell[],
  selectedThreadId: string | null,
): OrchestrationThreadShell | null {
  if (selectedThreadId === null) return null;
  return threads.find((thread) => thread.id === selectedThreadId) ?? null;
}

function keepSelectedVisible(
  visible: readonly OrchestrationThreadShell[],
  all: readonly OrchestrationThreadShell[],
  selectedThreadId: string | null,
): OrchestrationThreadShell[] {
  const selected = selectedThread(all, selectedThreadId);
  if (!selected || visible.some((thread) => thread.id === selected.id)) return [...visible];
  return [...visible, selected];
}

/**
 * Flat Sidebar V2 model. Projects filter the list; they no longer own nested
 * thread rows.
 *
 * The two sets retain the store's existing persistence shape:
 * - `expanded` contains the snoozed/settled section ids.
 * - `loadedInFull` contains the settled section id after "show more".
 */
export function buildRows(
  shell: OrchestrationShellSnapshot | null,
  expanded: ReadonlySet<string>,
  loadedInFull: ReadonlySet<string>,
  selectedThreadId: string | null,
  filter = "",
  projectScopeId: string | null = null,
  now = new Date().toISOString(),
): Row[] {
  if (!shell) return [];

  const projectTitleById = new Map(
    shell.projects.map((project) => [project.id as string, project.title] as const),
  );
  const needle = filter.trim().toLowerCase();
  const visibleThreads = shell.threads.filter((thread) => {
    if (thread.archivedAt != null) return false;
    if (projectScopeId !== null && thread.projectId !== projectScopeId) return false;
    if (needle.length === 0) return true;
    const projectTitle = projectTitleById.get(thread.projectId as string) ?? thread.projectId;
    return (
      thread.title.toLowerCase().includes(needle) || projectTitle.toLowerCase().includes(needle)
    );
  });

  const active: OrchestrationThreadShell[] = [];
  const snoozed: OrchestrationThreadShell[] = [];
  const settled: OrchestrationThreadShell[] = [];
  for (const thread of visibleThreads) {
    // Snooze is the stronger lifecycle statement and therefore wins when a
    // thread could otherwise also auto-settle, matching the web UI.
    if (effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
    } else if (
      effectiveSettled(thread, {
        now,
        autoSettleAfterDays: DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
      })
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  active.sort(activeOrder);
  snoozed.sort(
    (left, right) =>
      timestampMs(left.snoozedUntil) - timestampMs(right.snoozedUntil) ||
      left.id.localeCompare(right.id),
  );
  settled.sort(
    (left, right) =>
      timestampMs(settledTimestamp(right)) - timestampMs(settledTimestamp(left)) ||
      left.id.localeCompare(right.id),
  );

  const rowFor = (thread: OrchestrationThreadShell, section: SidebarSection): Row => ({
    kind: "thread",
    id: thread.id,
    thread,
    section,
    projectTitle: projectTitleById.get(thread.projectId as string) ?? thread.projectId,
    timestamp: section === "settled" ? settledTimestamp(thread) : thread.updatedAt,
  });

  const rows: Row[] = active.map((thread) => rowFor(thread, "active"));
  const searchExpanded = needle.length > 0;
  if (snoozed.length > 0) {
    const sectionExpanded = searchExpanded || expanded.has(SIDEBAR_SNOOZED_SECTION_ID);
    rows.push({
      kind: "section",
      id: SIDEBAR_SNOOZED_SECTION_ID,
      section: "snoozed",
      title: "Snoozed",
      count: snoozed.length,
      expanded: sectionExpanded,
    });
    const shown = sectionExpanded ? snoozed : keepSelectedVisible([], snoozed, selectedThreadId);
    rows.push(...shown.map((thread) => rowFor(thread, "snoozed")));
  }

  if (settled.length > 0) {
    const sectionExpanded = searchExpanded || expanded.has(SIDEBAR_SETTLED_SECTION_ID);
    rows.push({
      kind: "section",
      id: SIDEBAR_SETTLED_SECTION_ID,
      section: "settled",
      title: "Settled",
      count: settled.length,
      expanded: sectionExpanded,
    });
    const preview = loadedInFull.has(SIDEBAR_SETTLED_SECTION_ID)
      ? settled
      : settled.slice(0, SIDEBAR_SETTLED_INITIAL_COUNT);
    const shown = sectionExpanded
      ? keepSelectedVisible(preview, settled, selectedThreadId)
      : keepSelectedVisible([], settled, selectedThreadId);
    rows.push(...shown.map((thread) => rowFor(thread, "settled")));
    const hidden = settled.length - shown.length;
    if (sectionExpanded && hidden > 0) {
      rows.push({
        kind: "more",
        id: SIDEBAR_SETTLED_SECTION_ID,
        section: "settled",
        hiddenCount: hidden,
      });
    }
  }
  return rows;
}

export function rowHeight(row: Row): number {
  return row.kind === "thread" && row.section === "active" ? 2 : 1;
}

/** Window variable-height rows while keeping the selected row on screen. */
export function windowRows(
  rows: readonly Row[],
  selection: Selection | null,
  height: number,
): { readonly rows: Row[]; readonly moreAbove: boolean; readonly moreBelow: boolean } {
  if (rows.length === 0 || height <= 0) {
    return { rows: [], moreAbove: false, moreBelow: rows.length > 0 };
  }
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => selectionEquals(selection, row)),
  );
  let start = selectedIndex;
  let end = selectedIndex + 1;
  let used = rowHeight(rows[selectedIndex]!);
  let takeAfter = true;
  while (true) {
    const canTakeAfter = end < rows.length && used + rowHeight(rows[end]!) <= height;
    const canTakeBefore = start > 0 && used + rowHeight(rows[start - 1]!) <= height;
    if (!canTakeAfter && !canTakeBefore) break;
    if (canTakeAfter && (takeAfter || !canTakeBefore)) {
      used += rowHeight(rows[end]!);
      end += 1;
    } else if (canTakeBefore) {
      used += rowHeight(rows[start - 1]!);
      start -= 1;
    }
    takeAfter = !takeAfter;
  }
  return {
    rows: rows.slice(start, end),
    moreAbove: start > 0,
    moreBelow: end < rows.length,
  };
}
