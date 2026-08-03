import { describe, expect, it } from "vite-plus/test";
import {
  buildHistoryRows,
  clampHistoryDrawerHeight,
  historyCommitRowHeight,
  historyDayKey,
  historyRowHeight,
  HISTORY_COMMIT_ROW_HEIGHT,
  HISTORY_COMMIT_ROW_MIN_HEIGHT,
  HISTORY_DAY_ROW_HEIGHT,
  HISTORY_DEFAULT_DRAWER_HEIGHT,
  HISTORY_LOAD_MORE_ROW_HEIGHT,
  HISTORY_MAX_DRAWER_HEIGHT,
  HISTORY_MIN_DRAWER_HEIGHT,
  isHistoryCommitRow,
} from "./historyRows";
import type { WorkingCopyLogEntry } from "./types";

// The drawer being its OWN row is the whole point: nested inside its commit it
// made the row's height unknowable before mount, which is the one number a
// windowed list needs first.

const entry = (
  hash: string,
  authoredAt: string,
  parents: ReadonlyArray<string> = ["p"],
): WorkingCopyLogEntry => ({
  hash,
  shortHash: hash.slice(0, 7),
  subject: `commit ${hash}`,
  authorName: "Ada",
  authorEmail: "ada@example.com",
  authoredAt,
  parents,
});

const DAY_A = "2026-07-20T10:00:00.000Z";
const DAY_A_LATER = "2026-07-20T18:00:00.000Z";
const DAY_B = "2026-07-19T10:00:00.000Z";

const build = (over: Partial<Parameters<typeof buildHistoryRows>[0]> = {}) =>
  buildHistoryRows({
    entries: [],
    grouped: false,
    expandedHash: null,
    canLoadMore: false,
    ...over,
  });

describe("buildHistoryRows", () => {
  it("is one row per commit when ungrouped and nothing is expanded", () => {
    const rows = build({ entries: [entry("a", DAY_A), entry("b", DAY_B)] });
    expect(rows.map((row) => [row.kind, row.key])).toEqual([
      ["commit", "a"],
      ["commit", "b"],
    ]);
  });

  it("inserts a day separator when the calendar day changes", () => {
    const rows = build({
      entries: [entry("a", DAY_A), entry("b", DAY_A_LATER), entry("c", DAY_B)],
      grouped: true,
    });
    expect(rows.map((row) => row.kind)).toEqual(["day", "commit", "commit", "day", "commit"]);
    expect(rows[0]!.key).toBe(`day:${historyDayKey(DAY_A)}`);
    expect(rows[3]!.key).toBe(`day:${historyDayKey(DAY_B)}`);
  });

  it("emits no day separators when grouping is off", () => {
    const rows = build({ entries: [entry("a", DAY_A), entry("b", DAY_B)], grouped: false });
    expect(rows.some((row) => row.kind === "day")).toBe(false);
  });

  it("inserts the drawer at exactly commitIndex + 1", () => {
    const rows = build({
      entries: [entry("a", DAY_A), entry("b", DAY_B), entry("c", DAY_B)],
      expandedHash: "b",
    });
    const index = rows.findIndex((row) => row.kind === "commit" && row.hash === "b");
    expect(rows[index + 1]!.kind).toBe("drawer");
    expect(rows[index + 1]!.hash).toBe("b");
    expect(rows[index + 1]!.key).toBe("drawer:b");
  });

  it("opens at most one drawer", () => {
    const rows = build({ entries: [entry("a", DAY_A), entry("b", DAY_B)], expandedHash: "a" });
    expect(rows.filter((row) => row.kind === "drawer")).toHaveLength(1);
  });

  it("inserts no drawer when the expanded hash is not in the visible list", () => {
    const rows = build({ entries: [entry("a", DAY_A)], expandedHash: "gone" });
    expect(rows.some((row) => row.kind === "drawer")).toBe(false);
  });

  it("drawer + day separator coexist without disturbing the commit order", () => {
    const rows = build({
      entries: [entry("a", DAY_A), entry("b", DAY_B)],
      grouped: true,
      expandedHash: "a",
    });
    expect(rows.map((row) => row.kind)).toEqual(["day", "commit", "drawer", "day", "commit"]);
  });

  it("appends the load-more row only when there is more to load", () => {
    const entries = [entry("a", DAY_A)];
    expect(build({ entries }).some((row) => row.kind === "load-more")).toBe(false);
    const rows = build({ entries, canLoadMore: true });
    expect(rows[rows.length - 1]!.kind).toBe("load-more");
  });

  it("never emits a lone load-more row for an empty list", () => {
    expect(build({ entries: [], canLoadMore: true })).toEqual([]);
  });

  it("every row key is unique, so list item identity is stable", () => {
    const rows = build({
      entries: [entry("a", DAY_A), entry("b", DAY_A_LATER), entry("c", DAY_B)],
      grouped: true,
      expandedHash: "b",
      canLoadMore: true,
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("isHistoryCommitRow skips day, drawer and load-more rows", () => {
    const rows = build({
      entries: [entry("a", DAY_A)],
      grouped: true,
      expandedHash: "a",
      canLoadMore: true,
    });
    expect(rows.filter(isHistoryCommitRow).map((row) => row.hash)).toEqual(["a"]);
  });
});

describe("historyRowHeight", () => {
  const options = { density: "comfort" as const, width: "md" as const, drawerHeight: 400 };

  it("gives every non-commit row its own constant", () => {
    expect(historyRowHeight({ key: "d", kind: "day" }, options)).toBe(HISTORY_DAY_ROW_HEIGHT);
    expect(historyRowHeight({ key: "m", kind: "load-more" }, options)).toBe(
      HISTORY_LOAD_MORE_ROW_HEIGHT,
    );
  });

  it("uses the MEASURED drawer height, not a guess", () => {
    expect(historyRowHeight({ key: "x", kind: "drawer" }, options)).toBe(400);
    expect(
      historyRowHeight(
        { key: "x", kind: "drawer" },
        { ...options, drawerHeight: HISTORY_DEFAULT_DRAWER_HEIGHT },
      ),
    ).toBe(HISTORY_DEFAULT_DRAWER_HEIGHT);
  });

  it("tracks the same density/width formula the commit row uses for its lane graph", () => {
    expect(historyCommitRowHeight("comfort", "md")).toBe(HISTORY_COMMIT_ROW_HEIGHT.comfort.twoLine);
    expect(historyCommitRowHeight("compact", "md")).toBe(HISTORY_COMMIT_ROW_HEIGHT.compact.twoLine);
    // The single-line variants are clamped by the row's min-height.
    expect(historyCommitRowHeight("compact", "xs")).toBe(HISTORY_COMMIT_ROW_HEIGHT.compact.oneLine);
    expect(historyCommitRowHeight("comfort", "xs")).toBe(HISTORY_COMMIT_ROW_HEIGHT.comfort.oneLine);
    expect(historyRowHeight({ key: "a", kind: "commit" }, options)).toBe(
      HISTORY_COMMIT_ROW_HEIGHT.comfort.twoLine,
    );
  });

  // fork: f4 redesign (audit §8 / m9) — the pitch ladder was re-derived for
  // t3's type scale. These pin the two properties that matter, not the
  // literals: nothing below the house 28px single-line row, and every step on
  // the 4px grid the rest of the app uses.
  it("keeps every pitch on the 4px grid and at or above the house row height", () => {
    const heights = [
      HISTORY_DAY_ROW_HEIGHT,
      HISTORY_LOAD_MORE_ROW_HEIGHT,
      HISTORY_COMMIT_ROW_MIN_HEIGHT,
      ...Object.values(HISTORY_COMMIT_ROW_HEIGHT).flatMap((pair) => Object.values(pair)),
    ];
    for (const height of heights) {
      expect(height % 4).toBe(0);
    }
    for (const density of ["compact", "comfort"] as const) {
      for (const width of ["xs", "sm", "md", "lg", "xl"] as const) {
        expect(historyCommitRowHeight(density, width)).toBeGreaterThanOrEqual(
          HISTORY_COMMIT_ROW_MIN_HEIGHT,
        );
      }
    }
  });

  it("never makes a two-line row shorter than a one-line row at the same density", () => {
    for (const density of ["compact", "comfort"] as const) {
      expect(HISTORY_COMMIT_ROW_HEIGHT[density].twoLine).toBeGreaterThan(
        HISTORY_COMMIT_ROW_HEIGHT[density].oneLine,
      );
    }
  });
});

// fork: f4 redesign (audit §8 / M6) — the drawer height is measured now. It was
// permanently 280px, and its own comment said "used until the open drawer has
// been measured" while nothing ever measured it.
describe("clampHistoryDrawerHeight", () => {
  it("falls back to the default before anything has been measured", () => {
    expect(clampHistoryDrawerHeight(null)).toBe(HISTORY_DEFAULT_DRAWER_HEIGHT);
  });

  it("refuses a zero or nonsense measurement rather than collapsing the row", () => {
    expect(clampHistoryDrawerHeight(0)).toBe(HISTORY_DEFAULT_DRAWER_HEIGHT);
    expect(clampHistoryDrawerHeight(-40)).toBe(HISTORY_DEFAULT_DRAWER_HEIGHT);
    expect(clampHistoryDrawerHeight(Number.NaN)).toBe(HISTORY_DEFAULT_DRAWER_HEIGHT);
  });

  it("lets a one-file commit be short instead of opening 280px of empty panel", () => {
    expect(clampHistoryDrawerHeight(90)).toBe(HISTORY_MIN_DRAWER_HEIGHT);
    expect(clampHistoryDrawerHeight(180)).toBe(180);
  });

  it("caps a sixty-file commit so one drawer cannot eat the list", () => {
    expect(clampHistoryDrawerHeight(2_400)).toBe(HISTORY_MAX_DRAWER_HEIGHT);
  });

  it("rounds, so a sub-pixel measurement cannot re-trigger the virtualizer", () => {
    expect(clampHistoryDrawerHeight(200.4)).toBe(200);
    expect(clampHistoryDrawerHeight(200.6)).toBe(201);
  });
});
