import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { revealThreadTerminal } from "./revealThreadTerminal";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("settled-thread"));
const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);

beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
});

it("reveals a server-created setup terminal without adding a default shell", () => {
  revealThreadTerminal(threadRef, "setup-install");
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ),
  ).toMatchObject({
    terminalOpen: true,
    terminalIds: ["setup-install"],
    activeTerminalId: "setup-install",
  });
});

it("reopens the existing panel and selects a running terminal in its split", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "terminal-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "setup-install");
  panels.activateTerminal(threadRef, surfaceId, "terminal-1");
  panels.close(threadRef);

  revealThreadTerminal(threadRef, "setup-install");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [
      {
        terminalIds: ["terminal-1", "setup-install"],
        activeTerminalId: "setup-install",
      },
    ],
  });
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual([]);
});

it("reveals terminals in their own environment without changing another environment's drawer", () => {
  revealThreadTerminal(threadRef, "default");
  revealThreadTerminal(remoteRef, "setup-install");
  const state = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
  expect(selectThreadTerminalUiState(state, threadRef).terminalIds).toEqual(["default"]);
  expect(selectThreadTerminalUiState(state, remoteRef).terminalIds).toEqual(["setup-install"]);
});
