import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);
const layout = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    THREAD_REF,
  );

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      serverObservationsByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  it("discards a failed split without changing layout or hiding a later session with its ID", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "first");
    store.splitTerminalVertical(THREAD_REF, "second");
    store.splitTerminal(THREAD_REF, "pending", null);

    store.discardTerminalPlacement(THREAD_REF, "pending");
    expect(layout().terminalGroups).toEqual([
      expect.objectContaining({ terminalIds: ["first", "second"], splitDirection: "vertical" }),
    ]);

    store.reconcileTerminalIds(THREAD_REF, ["first", "second", "pending"]);
    expect(layout().terminalIds).toContain("pending");
  });

  it.each([
    { change: "no selection change", select: "", close: "", expected: "first" },
    { change: "a newer selection", select: "second", close: "", expected: "second" },
    { change: "the previous tab closing", select: "", close: "first", expected: "third" },
  ])(
    "selects the right tab after a rejected launch with $change",
    ({ select, close, expected }) => {
      const store = useTerminalUiStateStore.getState();
      for (const id of ["first", "second", "third"]) store.newTerminal(THREAD_REF, id);
      store.setActiveTerminal(THREAD_REF, "first");
      store.newTerminal(THREAD_REF, "pending");
      if (select) store.setActiveTerminal(THREAD_REF, select);
      if (close) store.closeTerminal(THREAD_REF, close);

      store.discardTerminalPlacement(THREAD_REF, "pending", "first");

      expect(layout().activeTerminalId).toBe(expected);
    },
  );

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
    });
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it.each([
    ["terminal-3", "terminal-3", DEFAULT_THREAD_TERMINAL_ID],
    [DEFAULT_THREAD_TERMINAL_ID, DEFAULT_THREAD_TERMINAL_ID, "terminal-3"],
    ["terminal-3", DEFAULT_THREAD_TERMINAL_ID, "terminal-3"],
  ])("keeps the split's tab when %s is active and %s closes", (activeId, closedId, nextId) => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(THREAD_REF, "terminal-2");
    store.setActiveTerminal(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.setActiveTerminal(THREAD_REF, activeId);
    store.closeTerminal(THREAD_REF, closedId);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe(nextId);
    expect(terminalUiState.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });

  it("drops terminals the server stops reporting but keeps ones it has not reported yet", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(THREAD_REF, "term-2");
    store.newTerminal(THREAD_REF, "term-3");
    const terminalIds = () =>
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds;

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(terminalIds()).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"]);

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID]);
    expect(terminalIds()).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-3"]);
  });

  it("preserves a vertical split while the terminals reattach to a restarted server", () => {
    const store = useTerminalUiStateStore.getState();
    const firstSnapshot = "manager-1";
    const restartSnapshot = "manager-2";
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminalVertical(THREAD_REF, "split");
    const beforeRestart = layout();

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "split"], firstSnapshot);
    store.reconcileTerminalIds(THREAD_REF, [], restartSnapshot);
    expect(layout()).toEqual(beforeRestart);

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID], restartSnapshot);
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "split"], restartSnapshot);
    expect(layout()).toEqual(beforeRestart);

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID], restartSnapshot);
    expect(layout().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
  });

  it("drops a background terminal that closed before the drawer reloaded", async () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "old"], "manager-1");
    const { name, storage } = useTerminalUiStateStore.persist.getOptions();
    if (!name || !storage) throw new Error("Terminal layout storage is unavailable");
    const saved = await storage.getItem(name);
    if (!saved) throw new Error("Terminal layout was not saved");
    store.removeTerminalUiState(THREAD_REF);
    await storage.setItem(name, saved);
    await useTerminalUiStateStore.persist.rehydrate();

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "new"], "manager-1");

    expect(layout().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "new"]);
  });

  it.each([
    ["unmounts right after the close", false],
    ["sees the closing terminal once more before it unmounts", true],
  ])("keeps a reopened terminal when the drawer %s", (_case, staleReconcile) => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID], "manager-1");
    store.closeTerminal(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);
    if (staleReconcile) {
      store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID], "manager-1");
    }
    // The drawer is gone now, so nothing reconciles the server dropping the terminal.
    store.ensureTerminal(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID, { open: true });
    store.reconcileTerminalIds(THREAD_REF, [], "manager-1");

    expect(layout().terminalOpen).toBe(true);
    expect(layout().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
  });

  it("keeps the surviving pane active when another client closes its split sibling", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "first");
    store.newTerminal(THREAD_REF, "second");
    store.splitTerminalVertical(THREAD_REF, "split");
    store.reconcileTerminalIds(THREAD_REF, ["first", "second", "split"]);

    store.reconcileTerminalIds(THREAD_REF, ["first", "second"]);

    expect(layout().activeTerminalId).toBe("second");
    expect(layout().activeTerminalGroupId).toBe("group-second");
  });

  it("preserves a pending local split when another client opens a tab", () => {
    const store = useTerminalUiStateStore.getState();
    store.reconcileTerminalIds(THREAD_REF, ["first"]);
    store.splitTerminalVertical(THREAD_REF, "pending");

    store.reconcileTerminalIds(THREAD_REF, ["first", "elsewhere"]);
    store.reconcileTerminalIds(THREAD_REF, ["first", "elsewhere", "pending"]);

    expect(layout().terminalGroups).toEqual([
      { id: "group-first", terminalIds: ["first", "pending"], splitDirection: "vertical" },
      { id: "group-elsewhere", terminalIds: ["elsewhere"] },
    ]);
    expect(layout().activeTerminalId).toBe("pending");
  });
});
