import { describe, expect, it } from "bun:test";

import { addTab, closeTab, cycleActiveId, initialTabs, nextTerminalId } from "./terminalTabs.ts";

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
