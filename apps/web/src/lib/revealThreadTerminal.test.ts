import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { revealThreadTerminal } from "./revealThreadTerminal";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("settled-thread"));
const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    terminalDrawer: { open: false, height: 280 },
    unseenGroupsByThreadKey: {},
  });
});

it("reopens the existing panel and selects a running terminal in its split", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "terminal-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeTerminalSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "setup-install");
  panels.activateTerminal(threadRef, surfaceId, "terminal-1");
  panels.close(threadRef);
  panels.setTerminalDrawerOpen(threadRef, false);

  revealThreadTerminal(threadRef, "setup-install");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeTerminalSurfaceId: surfaceId,
    surfaces: [
      {
        terminalIds: ["terminal-1", "setup-install"],
        activeTerminalId: "setup-install",
      },
    ],
  });
  expect(useRightPanelStore.getState().terminalDrawer.open).toBe(true);
});

it("reveals an unowned terminal as a drawer sub-tab and opens the drawer", () => {
  revealThreadTerminal(threadRef, "default");
  revealThreadTerminal(remoteRef, "setup-install");
  const state = useRightPanelStore.getState();
  expect(selectThreadRightPanelState(state.byThreadKey, threadRef)).toMatchObject({
    isOpen: true,
    activeTerminalSurfaceId: "terminal:default",
  });
  expect(
    selectThreadRightPanelState(state.byThreadKey, remoteRef).surfaces.map((surface) => surface.id),
  ).toEqual(["terminal:setup-install"]);
  expect(state.terminalDrawer.open).toBe(true);
});
