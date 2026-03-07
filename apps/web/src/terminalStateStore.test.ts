import { ThreadId } from "@t3tools/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { selectThreadTerminalState, useTerminalStateStore } from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("terminalStateStore actions", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID);
    expect(terminalState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID);
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", true);
    expect(selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID).runningTerminalIds).toEqual([
      "terminal-2",
    ]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", false);
    expect(selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID).runningTerminalIds).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID).terminalIds).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("reorders terminals within a split group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-3", {
      type: "before",
      targetTerminalId: "default",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-3");
    expect(terminalState.terminalIds).toEqual(["terminal-3", "default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["terminal-3", "default", "terminal-2"] },
    ]);
  });

  it("treats same-split adjacent drops as a no-op reorder", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    const beforeMove = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    store.moveTerminal(THREAD_ID, "terminal-2", {
      type: "after",
      targetTerminalId: "default",
    });

    const afterMove = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(afterMove).toEqual(beforeMove);
  });

  it("moves a terminal into another group and turns it into a split", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.newTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-3", {
      type: "group",
      targetGroupId: "group-default",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-3");
    expect(terminalState.activeTerminalGroupId).toBe("group-default");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-3"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("separates a terminal out of a split into its own group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");

    store.moveTerminal(THREAD_ID, "terminal-2", {
      type: "new-group",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-3"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });
});
