import { describe, expect, it } from "vite-plus/test";
import {
  appendLogPage,
  applyLogPage,
  mergeLogHead,
  nextLogCursor,
  EMPTY_LOG_PAGE_STATE,
  type LogPageState,
} from "./logPaging";
import type { WorkingCopyLogEntry } from "./types";

/**
 * The log is paged: the client holds several cursor pages while a server push
 * only ever re-reads the newest one.
 *
 * Two things must be true. "Load more" APPENDS, and a refreshed first page
 * FOLDS INTO the loaded log rather than truncating it back to one page.
 */

const entry = (hash: string, authoredAt = "2026-07-20T10:00:00.000Z"): WorkingCopyLogEntry => ({
  hash,
  shortHash: hash.slice(0, 7),
  subject: `feat: ${hash}`,
  authorName: "Ada",
  authorEmail: "ada@example.com",
  authoredAt,
  parents: [],
});

const hashes = (entries: ReadonlyArray<WorkingCopyLogEntry>) => entries.map((item) => item.hash);

const state = (entries: ReadonlyArray<WorkingCopyLogEntry>, hasMore: boolean): LogPageState => ({
  entries,
  hasMore,
});

describe("appendLogPage", () => {
  it("appends an older page in order", () => {
    expect(hashes(appendLogPage([entry("a"), entry("b")], [entry("c"), entry("d")]))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops a hash that is already loaded (a re-issued page)", () => {
    expect(hashes(appendLogPage([entry("a"), entry("b")], [entry("b"), entry("c")]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op for an empty page", () => {
    expect(hashes(appendLogPage([entry("a")], []))).toEqual(["a"]);
  });
});

describe("mergeLogHead", () => {
  const options = { freshHasMore: true, existingHasMore: false };

  it("keeps the older tail when the fresh page still overlaps it", () => {
    const merged = mergeLogHead(
      [entry("c3"), entry("c2"), entry("c1")],
      [entry("c4"), entry("c3")],
      options,
    );
    expect(hashes(merged.entries)).toEqual(["c4", "c3", "c2", "c1"]);
    // The tail survived, so the DEEPEST page's answer is still the right one.
    expect(merged.hasMore).toBe(false);
  });

  it("drops the tail when the fresh page no longer joins up (rewritten history)", () => {
    const merged = mergeLogHead(
      [entry("c3"), entry("c2"), entry("c1")],
      [entry("x2"), entry("x1")],
      options,
    );
    expect(hashes(merged.entries)).toEqual(["x2", "x1"]);
    expect(merged.hasMore).toBe(true);
  });

  it("never duplicates the overlapping commit", () => {
    const merged = mergeLogHead([entry("c2"), entry("c1")], [entry("c2"), entry("c1")], options);
    expect(hashes(merged.entries)).toEqual(["c2", "c1"]);
  });

  it("an empty fresh page empties the list — the branch has no commits", () => {
    const merged = mergeLogHead([entry("c1")], [], { ...options, freshHasMore: false });
    expect(merged.entries).toEqual([]);
    expect(merged.hasMore).toBe(false);
  });
});

describe("applyLogPage", () => {
  it("appends a cursor page without duplicating what is loaded", () => {
    const next = applyLogPage(
      state([entry("c4"), entry("c3")], true),
      { entries: [entry("c3"), entry("c2"), entry("c1")], hasMore: false },
      "append",
    );
    expect(hashes(next.entries)).toEqual(["c4", "c3", "c2", "c1"]);
    expect(next.hasMore).toBe(false);
  });

  it("does not truncate loaded pages when a refresh re-reads the first page", () => {
    let current = applyLogPage(
      state([entry("c4"), entry("c3")], true),
      { entries: [entry("c2"), entry("c1")], hasMore: false },
      "append",
    );
    // A refresh only ever asks for the newest page.
    current = applyLogPage(current, { entries: [entry("c4"), entry("c3")], hasMore: true }, "head");
    expect(hashes(current.entries)).toEqual(["c4", "c3", "c2", "c1"]);
    expect(current.hasMore).toBe(false);
  });

  it("prepends genuinely new commits found by a refresh", () => {
    const next = applyLogPage(
      state([entry("c3"), entry("c2"), entry("c1")], false),
      { entries: [entry("c4"), entry("c3")], hasMore: true },
      "head",
    );
    expect(hashes(next.entries)).toEqual(["c4", "c3", "c2", "c1"]);
  });

  it("replaces the whole list on a rebase discontinuity", () => {
    const next = applyLogPage(
      state([entry("c3"), entry("c2"), entry("c1")], false),
      { entries: [entry("x2"), entry("x1")], hasMore: true },
      "head",
    );
    expect(hashes(next.entries)).toEqual(["x2", "x1"]);
    expect(next.hasMore).toBe(true);
  });

  it("keeps state identity when a refresh finds nothing new", () => {
    const before = state([entry("c2"), entry("c1")], false);
    expect(
      applyLogPage(before, { entries: [entry("c2"), entry("c1")], hasMore: false }, "head"),
    ).toBe(before);
  });

  it("keeps state identity when an append page adds nothing", () => {
    const before = state([entry("c2"), entry("c1")], false);
    expect(applyLogPage(before, { entries: [entry("c1")], hasMore: false }, "append")).toBe(before);
  });

  it("returns a new state when only hasMore changed", () => {
    const before = state([entry("c1")], true);
    const next = applyLogPage(before, { entries: [entry("c1")], hasMore: false }, "head");
    expect(next).not.toBe(before);
    expect(next.hasMore).toBe(false);
  });

  it("starts from the empty state without special-casing", () => {
    const next = applyLogPage(
      EMPTY_LOG_PAGE_STATE,
      { entries: [entry("c2"), entry("c1")], hasMore: true },
      "head",
    );
    expect(hashes(next.entries)).toEqual(["c2", "c1"]);
    expect(next.hasMore).toBe(true);
  });
});

describe("nextLogCursor", () => {
  it("is the oldest loaded hash while more remains", () => {
    expect(nextLogCursor(state([entry("c2"), entry("c1")], true))).toBe("c1");
  });

  it("is null once the backend says there is no more", () => {
    expect(nextLogCursor(state([entry("c1")], false))).toBeNull();
  });

  it("is null for an empty log, even if hasMore is somehow set", () => {
    expect(nextLogCursor(state([], true))).toBeNull();
    expect(nextLogCursor(EMPTY_LOG_PAGE_STATE)).toBeNull();
  });
});
