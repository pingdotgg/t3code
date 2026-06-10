import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  migratePersistedTerminalStateStoreState,
  selectTerminalEventEntries,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "closed":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/tmp/workspace",
          worktreePath: null,
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
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
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"] },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { open: true, active: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "setup-setup"]);
    expect(terminalState.activeTerminalId).toBe("setup-setup");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["default", "env-b-terminal"]);
  });

  it("migrates v1 persisted terminal state using the stored version", () => {
    const migrated = migratePersistedTerminalStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
        },
      },
      1,
    );

    expect(migrated).toEqual({
      terminalStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
    });
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.setTerminalActivity(THREAD_REF, "terminal-2", true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_REF, "terminal-2", false);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_REF, "default");

    expect(
      useTerminalStateStore.getState().terminalStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("buffers terminal events outside persisted terminal UI state", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("output"));
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("activity"));

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "default",
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["output", "activity"]);
  });

  it("applies started terminal events to terminal state, launch context, and event buffer", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("started", {
        terminalId: "setup-bootstrap",
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "setup-bootstrap",
          cwd: "/tmp/worktree",
          worktreePath: "/tmp/worktree",
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "setup-bootstrap",
    );

    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.activeTerminalId).toBe("setup-bootstrap");
    expect(terminalState.terminalIds).toEqual(["default", "setup-bootstrap"]);
    expect(
      useTerminalStateStore.getState().terminalLaunchContextByThreadKey[
        scopedThreadKey(THREAD_REF)
      ],
    ).toEqual({
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.type).toBe("started");
  });

  it("applies activity and exited terminal events to subprocess state while buffering events", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "terminal-2", { open: true, active: true });

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: true,
      }),
    );
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("exited", {
        terminalId: "terminal-2",
        exitCode: 0,
        exitSignal: null,
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "terminal-2",
    );

    expect(terminalState.runningTerminalIds).toEqual([]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["activity", "exited"]);
  });

  it("clears buffered terminal events when a thread terminal state is removed", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("output"));
    store.removeTerminalState(THREAD_REF);

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "default",
    );

    expect(entries).toEqual([]);
  });

  it("is a no-op when clearing terminal state for a thread with no state or buffered events", () => {
    const store = useTerminalStateStore.getState();
    const before = useTerminalStateStore.getState();

    store.clearTerminalState(THREAD_REF);

    expect(useTerminalStateStore.getState()).toBe(before);
  });
});
