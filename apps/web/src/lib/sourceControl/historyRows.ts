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

// fork: f4 redesign (audit §8 / m9) — re-derived for t3's type scale. The old
// ladder (26 / 54 / 32 / 44 / 52 / 28 / 34) came from another app's type system
// and none of it sat on the 4px grid the rest of this app uses. The house
// single-line list pitch is 28px at `text-sm`; a two-line commit row is that
// plus one `text-xs` meta line.

export const HISTORY_DAY_ROW_HEIGHT = 24;
export const HISTORY_LOAD_MORE_ROW_HEIGHT = 48;
/** Used until the open drawer has been measured. */
export const HISTORY_DEFAULT_DRAWER_HEIGHT = 240;
/**
 * fork: f4 redesign (audit §8 / M6) — the drawer used to be permanently 280px
 * because nothing ever measured it, so a one-file commit opened 280px of empty
 * panel and a sixty-file commit opened a nested scroller inside the virtual
 * list. `HistoryList` measures the mounted drawer and feeds the height back
 * through here; these bounds keep one pathological commit from eating the list.
 */
export const HISTORY_MIN_DRAWER_HEIGHT = 120;
export const HISTORY_MAX_DRAWER_HEIGHT = 420;

/**
 * The height a MEASURED drawer contributes to the virtualizer.
 *
 * `null` (nothing measured yet) resolves to the default rather than to zero:
 * a zero-height row would collapse the list under the open drawer for a frame.
 */
export function clampHistoryDrawerHeight(measured: number | null): number {
  if (measured === null || !Number.isFinite(measured) || measured <= 0) {
    return HISTORY_DEFAULT_DRAWER_HEIGHT;
  }
  return Math.min(
    HISTORY_MAX_DRAWER_HEIGHT,
    Math.max(HISTORY_MIN_DRAWER_HEIGHT, Math.round(measured)),
  );
}

/** `.commit-row`'s min-height floor — the house single-line row pitch. */
export const HISTORY_COMMIT_ROW_MIN_HEIGHT = 28;

export type HistoryDensity = "compact" | "comfort";
/** Container-width bucket: xs <300 · sm 300–379 · md 380–459 · lg 460–539 · xl ≥540. */
export type HistoryWidth = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * The pitch table, exported so the row component and the element table can
 * assert against it instead of against a literal.
 */
export const HISTORY_COMMIT_ROW_HEIGHT = {
  compact: { oneLine: 28, twoLine: 36 },
  comfort: { oneLine: 32, twoLine: 44 },
} as const;

export function historyCommitRowHeight(density: HistoryDensity, width: HistoryWidth): number {
  const height = HISTORY_COMMIT_ROW_HEIGHT[density][width === "xs" ? "oneLine" : "twoLine"];
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
