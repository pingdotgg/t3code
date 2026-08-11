import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { applyNewThreadPanelDefaults } from "./newThreadPanelDefaults";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const BOTH_ON = { newThreadOpenFilesPanel: true, newThreadOpenTerminal: true };

const rightPanelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const terminalState = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.persist.clearStorage();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
});

describe("applyNewThreadPanelDefaults", () => {
  it("leaves both panels closed when the defaults are off", () => {
    applyNewThreadPanelDefaults(threadRef, {
      newThreadOpenFilesPanel: false,
      newThreadOpenTerminal: false,
    });

    expect(rightPanelState()).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("opens the files panel when the files default is on", () => {
    applyNewThreadPanelDefaults(threadRef, {
      newThreadOpenFilesPanel: true,
      newThreadOpenTerminal: false,
    });

    expect(rightPanelState()).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("opens the drawer with the default terminal when the terminal default is on", () => {
    applyNewThreadPanelDefaults(threadRef, {
      newThreadOpenFilesPanel: false,
      newThreadOpenTerminal: true,
    });

    expect(terminalState().terminalOpen).toBe(true);
    expect(terminalState().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(rightPanelState().isOpen).toBe(false);
  });

  it("opens both panels together without either clobbering the other", () => {
    applyNewThreadPanelDefaults(threadRef, BOTH_ON);

    expect(rightPanelState().isOpen).toBe(true);
    expect(terminalState().terminalOpen).toBe(true);
  });

  it("leaves a panel the user closed closed", () => {
    useRightPanelStore.getState().open(threadRef, "diff");
    useRightPanelStore.getState().close(threadRef);

    applyNewThreadPanelDefaults(threadRef, BOTH_ON);

    expect(rightPanelState()).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("leaves a chat alone once either store holds state for it", () => {
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);

    applyNewThreadPanelDefaults(threadRef, BOTH_ON);

    expect(rightPanelState().isOpen).toBe(false);
    expect(terminalState().terminalOpen).toBe(false);
  });
});
