import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "./hooks/useSettings";
import { applyNewThreadPanelDefaults } from "./newThreadPanelDefaults";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";

let threadCounter = 0;
function nextThreadRef() {
  threadCounter += 1;
  return scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(`thread-${threadCounter}`));
}

// Defaults are decided once per chat for the life of the session, so each test
// needs a chat of its own.
let threadRef = nextThreadRef();

interface PanelDefaults {
  newThreadOpenFilesPanel: boolean;
  newThreadOpenTerminal: boolean;
}

const BOTH_OFF: PanelDefaults = {
  newThreadOpenFilesPanel: false,
  newThreadOpenTerminal: false,
};
const FILES_ONLY: PanelDefaults = {
  newThreadOpenFilesPanel: true,
  newThreadOpenTerminal: false,
};
const TERMINAL_ONLY: PanelDefaults = {
  newThreadOpenFilesPanel: false,
  newThreadOpenTerminal: true,
};
const BOTH_ON: PanelDefaults = { newThreadOpenFilesPanel: true, newThreadOpenTerminal: true };

function settingsWith(defaults: PanelDefaults): ClientSettings {
  return { ...DEFAULT_CLIENT_SETTINGS, ...defaults };
}

// Settings that have already hydrated, which is the steady state everywhere
// except the first moments after startup.
function useSettings(defaults: PanelDefaults): void {
  __setClientSettingsForTests(settingsWith(defaults));
}

const rightPanelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const terminalState = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );

beforeEach(() => {
  threadRef = nextThreadRef();
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.persist.clearStorage();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
});

describe("applyNewThreadPanelDefaults", () => {
  it("leaves both panels closed when the defaults are off", async () => {
    useSettings(BOTH_OFF);

    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState()).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("opens the files panel when the files default is on", async () => {
    useSettings(FILES_ONLY);

    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState()).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("opens the drawer with the default terminal when the terminal default is on", async () => {
    useSettings(TERMINAL_ONLY);

    await applyNewThreadPanelDefaults(threadRef);

    expect(terminalState().terminalOpen).toBe(true);
    expect(terminalState().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(rightPanelState().isOpen).toBe(false);
  });

  it("opens both panels together without either clobbering the other", async () => {
    useSettings(BOTH_ON);

    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState().isOpen).toBe(true);
    expect(terminalState().terminalOpen).toBe(true);
  });

  it("applies the persisted defaults to a chat opened before settings hydrate", async () => {
    // The index route opens its draft as soon as projects load, which can beat
    // the settings read; until that lands the snapshot says both panels are off.
    __resetClientSettingsPersistenceForTests();
    expect(getClientSettings().newThreadOpenFilesPanel).toBe(false);

    const applied = applyNewThreadPanelDefaults(threadRef);
    // The persisted opt-ins land while the chat is already open.
    useSettings(BOTH_ON);
    await applied;

    expect(rightPanelState().isOpen).toBe(true);
    expect(terminalState().terminalOpen).toBe(true);
  });

  it("leaves a panel the user closed closed", async () => {
    useSettings(BOTH_ON);
    useRightPanelStore.getState().open(threadRef, "diff");
    useRightPanelStore.getState().close(threadRef);

    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState()).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("leaves a chat alone once either store holds state for it", async () => {
    useSettings(BOTH_ON);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);

    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState().isOpen).toBe(false);
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("leaves the terminal closed after the user closed the only terminal", async () => {
    useSettings(BOTH_ON);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    useTerminalUiStateStore.getState().closeTerminal(threadRef, DEFAULT_THREAD_TERMINAL_ID);
    // Closing the last terminal returns the thread to the default UI state, which
    // the store drops; the suppressed id is all that records the close.
    expect(
      scopedThreadKey(threadRef) in useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    ).toBe(false);

    await applyNewThreadPanelDefaults(threadRef);

    expect(terminalState().terminalOpen).toBe(false);
    expect(rightPanelState().isOpen).toBe(false);
  });

  it("does not re-default a chat whose layout the user emptied", async () => {
    useSettings(FILES_ONLY);
    await applyNewThreadPanelDefaults(threadRef);
    useRightPanelStore.getState().closeSurface(threadRef, "files");
    // The all-closed entry is dropped, so the store no longer tells this chat
    // apart from one that was never touched.
    expect(scopedThreadKey(threadRef) in useRightPanelStore.getState().byThreadKey).toBe(false);

    // "New chat" hands back this same unused draft.
    await applyNewThreadPanelDefaults(threadRef);

    expect(rightPanelState()).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
  });
});
