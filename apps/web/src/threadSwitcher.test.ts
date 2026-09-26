import { describe, expect, it } from "vite-plus/test";

import {
  advanceThreadSwitcherIndex,
  isThreadSwitcherHoldModifierKey,
  recordThreadSwitcherVisit,
  resolveThreadSwitcherEntries,
  resolveThreadSwitcherHoldModifier,
  resolveThreadSwitcherOrder,
  THREAD_SWITCHER_ENTRY_LIMIT,
  THREAD_SWITCHER_HISTORY_LIMIT,
} from "./threadSwitcher";

describe("thread switcher hold modifier", () => {
  it("prefers meta, then control, then alt", () => {
    expect(resolveThreadSwitcherHoldModifier({ metaKey: true, ctrlKey: true, altKey: true })).toBe(
      "metaKey",
    );
    expect(resolveThreadSwitcherHoldModifier({ metaKey: false, ctrlKey: true, altKey: true })).toBe(
      "ctrlKey",
    );
    expect(
      resolveThreadSwitcherHoldModifier({ metaKey: false, ctrlKey: false, altKey: true }),
    ).toBe("altKey");
  });

  it("reports no hold when the chord carries none of them", () => {
    expect(
      resolveThreadSwitcherHoldModifier({ metaKey: false, ctrlKey: false, altKey: false }),
    ).toBeNull();
  });

  it("commits on the held modifier's own keyup and ignores shift", () => {
    expect(isThreadSwitcherHoldModifierKey("Meta", "metaKey")).toBe(true);
    expect(isThreadSwitcherHoldModifierKey("Control", "ctrlKey")).toBe(true);
    expect(isThreadSwitcherHoldModifierKey("Alt", "altKey")).toBe(true);
    expect(isThreadSwitcherHoldModifierKey("Shift", "metaKey")).toBe(false);
    expect(isThreadSwitcherHoldModifierKey("Control", "metaKey")).toBe(false);
    expect(isThreadSwitcherHoldModifierKey("]", "metaKey")).toBe(false);
  });
});

describe("thread switcher history", () => {
  it("moves a revisited thread back to the front", () => {
    const history = recordThreadSwitcherVisit(["b", "a"], "a");
    expect(history).toEqual(["a", "b"]);
  });

  it("keeps the same array when the thread is already current", () => {
    const history = ["a", "b"] as const;
    expect(recordThreadSwitcherVisit(history, "a")).toBe(history);
  });

  it("caps the history", () => {
    let history: readonly string[] = [];
    for (let index = 0; index < THREAD_SWITCHER_HISTORY_LIMIT + 5; index += 1) {
      history = recordThreadSwitcherVisit(history, `thread-${index}`);
    }
    expect(history).toHaveLength(THREAD_SWITCHER_HISTORY_LIMIT);
    expect(history[0]).toBe(`thread-${THREAD_SWITCHER_HISTORY_LIMIT + 4}`);
  });
});

describe("thread switcher order", () => {
  it("puts the active thread first and the rest by recency", () => {
    expect(
      resolveThreadSwitcherOrder({
        threadKeys: ["a", "b", "c", "d"],
        history: ["c", "b"],
        activeThreadKey: "a",
      }),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("drops history entries that are no longer in the sidebar", () => {
    expect(
      resolveThreadSwitcherOrder({
        threadKeys: ["a", "b"],
        history: ["deleted", "b"],
        activeThreadKey: "a",
      }),
    ).toEqual(["a", "b"]);
  });

  it("falls back to sidebar order without any history", () => {
    expect(
      resolveThreadSwitcherOrder({
        threadKeys: ["a", "b", "c"],
        history: [],
        activeThreadKey: null,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("caps the offered entries", () => {
    const threadKeys = Array.from({ length: 40 }, (_, index) => `thread-${index}`);
    expect(
      resolveThreadSwitcherOrder({ threadKeys, history: [], activeThreadKey: "thread-39" }),
    ).toHaveLength(THREAD_SWITCHER_ENTRY_LIMIT);
  });
});

describe("thread switcher index", () => {
  it("wraps in both directions", () => {
    expect(advanceThreadSwitcherIndex({ index: 0, count: 3, direction: "next" })).toBe(1);
    expect(advanceThreadSwitcherIndex({ index: 2, count: 3, direction: "next" })).toBe(0);
    expect(advanceThreadSwitcherIndex({ index: 0, count: 3, direction: "previous" })).toBe(2);
  });

  it("stays at zero with nothing to switch between", () => {
    expect(advanceThreadSwitcherIndex({ index: 0, count: 0, direction: "next" })).toBe(0);
  });
});

describe("thread switcher entries", () => {
  it("keeps a deleted thread's row so the highlight and the opened thread stay aligned", () => {
    const threadKeys = ["active", "deleted-mid-switch", "highlighted"];
    const entries = resolveThreadSwitcherEntries(threadKeys, (threadKey) =>
      threadKey === "deleted-mid-switch" ? null : { title: threadKey, subtitle: null },
    );

    expect(entries.map((entry) => entry.threadKey)).toEqual(threadKeys);
    expect(entries[1]?.title).toBeNull();
    // Release opens threadKeys[index]; the overlay highlights entries[index].
    const index = 2;
    expect(entries[index]?.threadKey).toBe(threadKeys[index]);
    expect(entries[index]?.title).toBe("highlighted");
  });
});
