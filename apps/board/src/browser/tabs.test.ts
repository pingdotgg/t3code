import { describe, expect, it } from "vite-plus/test";

import { EMPTY_TABS, normalizeUrl, type Tab, tabsReducer } from "./tabs";

const tab = (id: string, url: string): Tab => ({
  id,
  url,
  title: "",
  loading: true,
  canGoBack: false,
  canGoForward: false,
});

describe("tabsReducer", () => {
  it("Given an empty list, when two tabs open then the first closes then it is activated, then each step lists the literal tabs and active id", () => {
    const afterFirst = tabsReducer(EMPTY_TABS, { type: "open", id: "a", url: "https://a.test/" });
    expect(afterFirst).toEqual({ tabs: [tab("a", "https://a.test/")], activeId: "a" });

    const afterSecond = tabsReducer(afterFirst, { type: "open", id: "b", url: "https://b.test/" });
    expect(afterSecond).toEqual({
      tabs: [tab("a", "https://a.test/"), tab("b", "https://b.test/")],
      activeId: "b",
    });

    const afterClose = tabsReducer(afterSecond, { type: "close", id: "a" });
    expect(afterClose).toEqual({ tabs: [tab("b", "https://b.test/")], activeId: "b" });

    const reopened = tabsReducer(afterClose, { type: "open", id: "c", url: "https://c.test/" });
    expect(tabsReducer(reopened, { type: "activate", id: "b" })).toEqual({
      tabs: [tab("b", "https://b.test/"), tab("c", "https://c.test/")],
      activeId: "b",
    });
  });

  it("Given three tabs with the middle one active, when it closes, then the tab after it becomes active", () => {
    let state = EMPTY_TABS;
    for (const id of ["a", "b", "c"]) {
      state = tabsReducer(state, { type: "open", id, url: `https://${id}.test/` });
    }
    state = tabsReducer(state, { type: "activate", id: "b" });
    expect(tabsReducer(state, { type: "close", id: "b" }).activeId).toBe("c");
  });

  it("Given the last tab is active, when it closes, then the tab before it becomes active", () => {
    let state = EMPTY_TABS;
    for (const id of ["a", "b"]) {
      state = tabsReducer(state, { type: "open", id, url: `https://${id}.test/` });
    }
    expect(tabsReducer(state, { type: "close", id: "b" }).activeId).toBe("a");
  });

  it("Given an active tab, when another tab closes, then the active tab stays", () => {
    let state = EMPTY_TABS;
    for (const id of ["a", "b"]) {
      state = tabsReducer(state, { type: "open", id, url: `https://${id}.test/` });
    }
    expect(tabsReducer(state, { type: "close", id: "a" }).activeId).toBe("b");
  });

  it("Given the only tab, when it closes, then no tab is active", () => {
    const state = tabsReducer(EMPTY_TABS, { type: "open", id: "a", url: "https://a.test/" });
    expect(tabsReducer(state, { type: "close", id: "a" })).toEqual(EMPTY_TABS);
  });

  it("Given an unknown id, when it is closed or activated, then the state is unchanged", () => {
    const state = tabsReducer(EMPTY_TABS, { type: "open", id: "a", url: "https://a.test/" });
    expect(tabsReducer(state, { type: "close", id: "x" })).toBe(state);
    expect(tabsReducer(state, { type: "activate", id: "x" })).toBe(state);
  });

  it("Given a page reports its title, when the tab updates, then only that tab changes", () => {
    let state = EMPTY_TABS;
    for (const id of ["a", "b"]) {
      state = tabsReducer(state, { type: "open", id, url: `https://${id}.test/` });
    }
    const next = tabsReducer(state, {
      type: "update",
      id: "a",
      patch: { title: "A page", loading: false },
    });
    expect(next.tabs).toEqual([
      { ...tab("a", "https://a.test/"), title: "A page", loading: false },
      tab("b", "https://b.test/"),
    ]);
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1"],
    ["github.com/o/r", "https://github.com/o/r"],
    ["localhost:5173", "http://localhost:5173/"],
    ["127.0.0.1:3000/app", "http://127.0.0.1:3000/app"],
    ["  http://example.test  ", "http://example.test/"],
  ])("Given %j, when it is normalized, then it is %j", (text, expected) => {
    expect(normalizeUrl(text)).toBe(expected);
  });

  it.each(["", "   ", "file:///etc/passwd", "javascript:alert(1)", "ftp://host/file", "a b"])(
    "Given %j, when it is normalized, then it is rejected",
    (text) => {
      expect(normalizeUrl(text)).toBeNull();
    },
  );
});
