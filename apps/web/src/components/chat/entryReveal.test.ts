import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PIN_HISTORY_PAGES,
  type PinHistoryPage,
  type PinHistorySnapshot,
  entryRevealExpands,
  pageUntilPinnedEntry,
} from "./entryReveal";

function scriptedPages(snapshots: ReadonlyArray<PinHistorySnapshot>) {
  let reads = 0;
  let loads = 0;
  return {
    get loads() {
      return loads;
    },
    run: (results: ReadonlyArray<PinHistoryPage> = []) =>
      pageUntilPinnedEntry({
        read: () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
        loadPage: async () => results[loads++] ?? "loaded",
      }),
  };
}

const missing = { loaded: false, hasMoreHistory: true } satisfies PinHistorySnapshot;

describe("entryRevealExpands", () => {
  it("opens the named fold once per pin click", () => {
    const request = { entryId: "plan-1", key: 4 };
    expect(entryRevealExpands(null, "plan-1", null)).toEqual({ expand: false, claimedKey: null });
    expect(entryRevealExpands(request, "other", null)).toEqual({ expand: false, claimedKey: null });
    expect(entryRevealExpands(request, "plan-1", null)).toEqual({ expand: true, claimedKey: 4 });
    expect(entryRevealExpands(request, "plan-1", 4)).toEqual({ expand: false, claimedKey: 4 });
    expect(entryRevealExpands({ ...request, key: 5 }, "plan-1", 4)).toEqual({
      expand: true,
      claimedKey: 5,
    });
  });
});

describe("pageUntilPinnedEntry", () => {
  it("reveals an entry that is already in the open window without paging", async () => {
    const pages = scriptedPages([{ loaded: true, hasMoreHistory: true }]);
    await expect(pages.run()).resolves.toBe(true);
    expect(pages.loads).toBe(0);
  });

  it("keeps paging when a loaded page does not contain the entry", async () => {
    const pages = scriptedPages([missing, missing, { loaded: true, hasMoreHistory: true }]);
    await expect(pages.run()).resolves.toBe(true);
    expect(pages.loads).toBe(2);
  });

  it("stops without another page once older history is exhausted", async () => {
    const pages = scriptedPages([missing, { loaded: false, hasMoreHistory: false }]);
    await expect(pages.run()).resolves.toBe(false);
    expect(pages.loads).toBe(1);
  });

  it("stops when a page fails to load", async () => {
    const pages = scriptedPages([missing]);
    await expect(pages.run(["error"])).resolves.toBe(false);
    expect(pages.loads).toBe(1);
  });

  it("stops when the store has nothing older to page", async () => {
    const pages = scriptedPages([missing]);
    await expect(pages.run(["noop"])).resolves.toBe(false);
    expect(pages.loads).toBe(1);
  });

  it("gives up after the same page cap citations use", async () => {
    const pages = scriptedPages([missing]);
    await expect(pages.run()).resolves.toBe(false);
    expect(pages.loads).toBe(MAX_PIN_HISTORY_PAGES);
  });
});
