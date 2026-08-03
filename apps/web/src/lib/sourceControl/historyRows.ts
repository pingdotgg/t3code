/**
 * The commit history as data.
 *
 * The expanded commit's drawer is its OWN row, inserted immediately after the
 * commit it belongs to, never nested inside it: a nested drawer makes a row's
 * height unknowable until it mounts, which is exactly the number a windowed
 * list needs first. Every row then has one height and offsets stay a prefix
 * sum.
 *
 * IMPORTANT: the lane graph is NOT built from these rows. `buildLaneGraph`
 * walks the full, contiguous, newest-first entry list — slicing it changes the
 * lanes. Rows only ever look their node up by hash.
 */

import type { WorkingCopyLogEntry } from "./types";

export type HistoryRowKind = "day" | "commit" | "drawer" | "load-more";

export interface HistoryRow {
  /** Stable row key. */
  readonly key: string;
  readonly kind: HistoryRowKind;
  /** Present on commit and drawer rows. */
  readonly entry?: WorkingCopyLogEntry;
  /** Commit hash, on commit and drawer rows. */
  readonly hash?: string;
  /** Human day label, on day rows. */
  readonly label?: string;
}

export interface BuildHistoryRowsInput {
  /** Already filtered and sorted — the list the user is looking at. */
  readonly entries: ReadonlyArray<WorkingCopyLogEntry>;
  /** Insert day separators. */
  readonly grouped: boolean;
  /** At most one drawer is open at a time. */
  readonly expandedHash: string | null;
  /** Older history may exist and loading more is wired up. */
  readonly canLoadMore: boolean;
}

const MS_PER_DAY = 86_400_000;

/** Calendar-day key, in the viewer's local timezone. */
export function historyDayKey(isoDate: string): string {
  const date = new Date(isoDate);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function historyDayLabel(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / MS_PER_DAY);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function buildHistoryRows(input: BuildHistoryRowsInput): ReadonlyArray<HistoryRow> {
  const rows: HistoryRow[] = [];
  let lastDayKey: string | null = null;

  for (const entry of input.entries) {
    if (input.grouped) {
      const key = historyDayKey(entry.authoredAt);
      if (key !== lastDayKey) {
        lastDayKey = key;
        rows.push({ key: `day:${key}`, kind: "day", label: historyDayLabel(entry.authoredAt) });
      }
    }
    rows.push({ key: entry.hash, kind: "commit", entry, hash: entry.hash });
    // Exactly at commitIndex + 1 — the drawer is visually part of its commit.
    if (input.expandedHash === entry.hash) {
      rows.push({ key: `drawer:${entry.hash}`, kind: "drawer", entry, hash: entry.hash });
    }
  }

  if (input.canLoadMore && input.entries.length > 0) {
    rows.push({ key: "load-more", kind: "load-more" });
  }
  return rows;
}

/** Rows the keyboard can land on. */
export function isHistoryCommitRow(row: HistoryRow): boolean {
  return row.kind === "commit";
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Heights the virtualizer needs before a row mounts. The commit height is the
// same formula the commit row uses for its own lane SVG, so lane segments meet
// across the row boundary.

export const HISTORY_DAY_ROW_HEIGHT = 26;
export const HISTORY_LOAD_MORE_ROW_HEIGHT = 54;
/** Used until the open drawer has been measured. */
export const HISTORY_DEFAULT_DRAWER_HEIGHT = 280;
/** `.commit-row`'s min-height floor. */
export const HISTORY_COMMIT_ROW_MIN_HEIGHT = 32;

export type HistoryDensity = "compact" | "comfort";
/** Container-width bucket: xs <300 · sm 300–379 · md 380–459 · lg 460–539 · xl ≥540. */
export type HistoryWidth = "xs" | "sm" | "md" | "lg" | "xl";

export function historyCommitRowHeight(density: HistoryDensity, width: HistoryWidth): number {
  const twoLine = width !== "xs";
  const height = twoLine ? (density === "compact" ? 44 : 52) : density === "compact" ? 28 : 34;
  return Math.max(height, HISTORY_COMMIT_ROW_MIN_HEIGHT);
}

export function historyRowHeight(
  row: HistoryRow,
  options: {
    readonly density: HistoryDensity;
    readonly width: HistoryWidth;
    readonly drawerHeight: number;
  },
): number {
  switch (row.kind) {
    case "day":
      return HISTORY_DAY_ROW_HEIGHT;
    case "load-more":
      return HISTORY_LOAD_MORE_ROW_HEIGHT;
    case "drawer":
      return options.drawerHeight;
    case "commit":
      return historyCommitRowHeight(options.density, options.width);
  }
}
