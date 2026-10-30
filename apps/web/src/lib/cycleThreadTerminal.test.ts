import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cycleThreadTerminal } from "./cycleThreadTerminal";
import { registerTerminalFocusTarget } from "./terminalFocus";

function setup() {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  return scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("cycle"));
}

it("cycles drawer tabs and split panes in display order, wraps both ways, and focuses the target", () => {
  const ref = setup();
  const drawer = useTerminalUiStateStore.getState();
  drawer.newTerminal(ref, "b");
  drawer.newTerminal(ref, "a");
  drawer.setActiveTerminal(ref, "a");
  drawer.splitTerminal(ref, "c");
  drawer.newTerminal(ref, "z");
  drawer.reconcileTerminalIds(ref, ["a", "b", "c", "z"]);
  let focused: string | null = null;
  const unregister = ["a", "c", "b", "z"].map((terminalId) =>
    registerTerminalFocusTarget({
      threadRef: ref,
      terminalId,
      focus: () => {
        focused = terminalId;
        return true;
      },
    }),
  );
  try {
    drawer.setActiveTerminal(ref, "a");
    for (const expected of ["c", "b", "z", "a"]) {
      expect(cycleThreadTerminal(ref, "drawer", "next")).toBe(true);
      expect(
        selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          ref,
        ).activeTerminalId,
      ).toBe(expected);
      expect(focused).toBe(expected);
    }
    cycleThreadTerminal(ref, "drawer", "previous");
    expect(focused).toBe("z");
    const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), ref.threadId);
    expect(cycleThreadTerminal(remoteRef, "drawer", "next")).toBe(false);
    drawer.setTerminalOpen(ref, false);
    expect(cycleThreadTerminal(ref, "drawer", "next")).toBe(false);
  } finally {
    for (const dispose of unregister) dispose();
  }
});

it("cycles panel terminal surfaces and splits without changing the drawer", () => {
  const ref = setup();
  const drawer = useTerminalUiStateStore.getState();
  drawer.newTerminal(ref, "drawer");
  const panels = useRightPanelStore.getState();
  panels.openTerminal(ref, "a");
  const firstSurfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    ref,
  ).activeSurfaceId!;
  panels.splitTerminal(ref, firstSurfaceId, "b");
  panels.openFile(ref, "notes.md");
  expect(cycleThreadTerminal(ref, "right-panel", "next")).toBe(false);
  panels.openTerminal(ref, "c");
  for (const [direction, expected] of [
    ["next", "a"],
    ["previous", "c"],
    ["previous", "b"],
  ] as const) {
    expect(cycleThreadTerminal(ref, "right-panel", direction)).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(active).toMatchObject({ kind: "terminal", activeTerminalId: expected });
  }
  expect(
    selectThreadTerminalUiState(useTerminalUiStateStore.getState().terminalUiStateByThreadKey, ref)
      .activeTerminalId,
  ).toBe("drawer");
  panels.close(ref);
  expect(cycleThreadTerminal(ref, "right-panel", "next")).toBe(false);
});
