import { describe, expect, it } from "bun:test";

import {
  addTab,
  closeTab,
  cycleActiveId,
  initialTabs,
  nextTerminalId,
  reduceKnownTerminals,
  tabsWithDiscovered,
} from "./terminalTabs.ts";

describe("terminal tabs", () => {
  it("nextTerminalId picks the next free term-N", () => {
    expect(nextTerminalId([])).toBe("term-1");
    expect(nextTerminalId(["term-1"])).toBe("term-2");
    expect(nextTerminalId(["term-1", "term-3"])).toBe("term-4");
  });

  it("initialTabs starts with the default terminal active", () => {
    expect(initialTabs()).toEqual({ ids: ["term-1"], activeId: "term-1" });
  });

  it("Given no tabs, when adding, then it seeds the default terminal", () => {
    expect(addTab(null)).toEqual({ ids: ["term-1"], activeId: "term-1" });
  });

  it("Given existing tabs, when adding, then a fresh terminal becomes active", () => {
    const tabs = addTab({ ids: ["term-1"], activeId: "term-1" });
    expect(tabs).toEqual({ ids: ["term-1", "term-2"], activeId: "term-2" });
  });

  it("Given the active tab is closed, then the last remaining tab becomes active", () => {
    const tabs = { ids: ["term-1", "term-2", "term-3"], activeId: "term-2" };
    expect(closeTab(tabs, "term-2")).toEqual({ ids: ["term-1", "term-3"], activeId: "term-3" });
  });

  it("Given an inactive tab is closed, then the active tab is unchanged", () => {
    const tabs = { ids: ["term-1", "term-2"], activeId: "term-2" };
    expect(closeTab(tabs, "term-1")).toEqual({ ids: ["term-2"], activeId: "term-2" });
  });

  it("Given the last tab is closed, then it returns null (drawer should close)", () => {
    expect(closeTab({ ids: ["term-1"], activeId: "term-1" }, "term-1")).toBeNull();
  });

  it("cycleActiveId wraps forward and backward, and no-ops on a single tab", () => {
    const tabs = { ids: ["term-1", "term-2", "term-3"], activeId: "term-3" };
    expect(cycleActiveId(tabs, 1)).toBe("term-1");
    expect(cycleActiveId(tabs, -1)).toBe("term-2");
    expect(cycleActiveId({ ids: ["term-1"], activeId: "term-1" }, 1)).toBe("term-1");
  });
});

describe("tabsWithDiscovered", () => {
  it("Given no local tabs, when terminals are discovered, then it seeds a sorted list", () => {
    const tabs = tabsWithDiscovered(null, ["term-2", "term-1"]);
    expect(tabs).toEqual({ ids: ["term-1", "term-2"], activeId: "term-1" });
  });

  it("Given existing tabs, when a new terminal is discovered, then it is unioned in, active preserved", () => {
    const tabs = tabsWithDiscovered({ ids: ["term-1"], activeId: "term-1" }, ["term-1", "term-2"]);
    expect(tabs).toEqual({ ids: ["term-1", "term-2"], activeId: "term-1" });
  });

  it("Given nothing new, then it returns the same reference (no state write)", () => {
    const original = { ids: ["term-1", "term-2"], activeId: "term-2" };
    expect(tabsWithDiscovered(original, ["term-1"])).toBe(original);
  });

  it("Given no discovered ids, then it returns the tabs untouched", () => {
    const original = { ids: ["term-1"], activeId: "term-1" };
    expect(tabsWithDiscovered(original, [])).toBe(original);
  });
});

describe("reduceKnownTerminals", () => {
  const snapshot = {
    type: "snapshot" as const,
    terminals: [
      { threadId: "t1", terminalId: "term-1" },
      { threadId: "t1", terminalId: "term-2" },
      { threadId: "t2", terminalId: "term-1" },
    ],
  };

  it("Given a snapshot, then it groups terminal ids by thread", () => {
    const map = reduceKnownTerminals(new Map(), snapshot);
    expect(map.get("t1")).toEqual(["term-1", "term-2"]);
    expect(map.get("t2")).toEqual(["term-1"]);
  });

  it("Given an upsert of a new terminal, then it appends it to that thread", () => {
    const map = reduceKnownTerminals(reduceKnownTerminals(new Map(), snapshot), {
      type: "upsert",
      terminal: { threadId: "t2", terminalId: "term-2" },
    });
    expect(map.get("t2")).toEqual(["term-1", "term-2"]);
  });

  it("Given a remove, then it drops the id (and the thread entry when empty)", () => {
    const map = reduceKnownTerminals(reduceKnownTerminals(new Map(), snapshot), {
      type: "remove",
      threadId: "t2",
      terminalId: "term-1",
    });
    expect(map.has("t2")).toBe(false);
    expect(map.get("t1")).toEqual(["term-1", "term-2"]);
  });
});
