import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  consumePendingTerminalFocus,
  focusActiveDrawerTerminal,
  focusActivePanelTerminal,
  focusPanelTerminalAfterClose,
  focusTerminal,
  focusTerminalOnNavigation,
  focusTerminalOnThreadEnter,
  registerTerminalFocusTarget,
} from "./terminalFocus";

const threadRef = (threadId: string) =>
  scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(threadId));

describe("focusTerminal", () => {
  it("focuses a mounted target right away", () => {
    const ref = threadRef("mounted");
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    focusTerminal(ref, "a");

    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("waits for the requested terminal to mount, then consumes the request", () => {
    const ref = threadRef("pending");
    focusTerminal(ref, "b");

    const other = vi.fn(() => true);
    const unregisterOther = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: other,
    });
    const target = vi.fn(() => true);
    const unregisterTarget = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "b",
      focus: target,
    });
    unregisterTarget();
    const remount = vi.fn(() => true);
    const unregisterRemount = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "b",
      focus: remount,
    });

    expect(other).not.toHaveBeenCalled();
    expect(target).toHaveBeenCalledTimes(1);
    expect(remount).not.toHaveBeenCalled();
    unregisterOther();
    unregisterRemount();
  });

  it("keeps only the newest request for a thread", () => {
    const ref = threadRef("newest");
    focusTerminal(ref, "a");
    focusTerminal(ref, "b");

    const first = vi.fn(() => true);
    const unregisterFirst = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: first,
    });
    const second = vi.fn(() => true);
    const unregisterSecond = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "b",
      focus: second,
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unregisterFirst();
    unregisterSecond();
  });

  it("keeps the request when a mounted target cannot take focus", () => {
    const ref = threadRef("hidden");
    const hidden = vi.fn(() => false);
    const unregisterHidden = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: hidden,
    });

    focusTerminal(ref, "a");
    unregisterHidden();
    const shown = vi.fn(() => true);
    const unregisterShown = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: shown,
    });

    expect(hidden).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledTimes(1);
    unregisterShown();
  });

  it("focuses a registered hidden target once it is shown", () => {
    const ref = threadRef("shown-later");
    let canFocus = false;
    const focus = vi.fn(() => canFocus);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    focusTerminal(ref, "a");
    canFocus = true;
    consumePendingTerminalFocus(ref, "a");
    consumePendingTerminalFocus(ref, "a");

    expect(focus).toHaveBeenCalledTimes(2);
    unregister();
  });

  it("drops a parked request once a newer one targets another thread", () => {
    const parked = threadRef("parked");
    const hidden = vi.fn(() => false);
    const unregisterHidden = registerTerminalFocusTarget({
      threadRef: parked,
      terminalId: "a",
      focus: hidden,
    });
    focusTerminal(parked, "a");

    const other = threadRef("other");
    const unregisterOther = registerTerminalFocusTarget({
      threadRef: other,
      terminalId: "b",
      focus: () => true,
    });
    focusTerminal(other, "b");
    unregisterHidden();
    const remount = vi.fn(() => true);
    const unregisterRemount = registerTerminalFocusTarget({
      threadRef: parked,
      terminalId: "a",
      focus: remount,
    });

    expect(remount).not.toHaveBeenCalled();
    unregisterOther();
    unregisterRemount();
  });

  it("drops a parked request when the thread's drawer closes", () => {
    const ref = threadRef("closed");
    useTerminalUiStateStore.getState().ensureTerminal(ref, "a", { open: true, active: true });
    focusActiveDrawerTerminal(ref);
    useTerminalUiStateStore.getState().setTerminalOpen(ref, false);
    focusActiveDrawerTerminal(ref);

    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  it("entering a thread with its drawer open focuses the active drawer terminal", () => {
    const ref = threadRef("entered");
    useTerminalUiStateStore.getState().ensureTerminal(ref, "a", { open: true, active: true });
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    const leave = focusTerminalOnThreadEnter(ref);

    expect(focus).toHaveBeenCalledTimes(1);
    leave();
    unregister();
  });

  it("entering a thread keeps the request its navigating handler made", () => {
    const ref = threadRef("revealed");
    useTerminalUiStateStore.getState().ensureTerminal(ref, "drawer", { open: true, active: true });
    focusTerminalOnNavigation(ref, "panel");

    // React commit order: the new thread's viewports attach and take the
    // request before ChatView's thread-enter effect runs.
    const drawer = vi.fn(() => true);
    const unregisterDrawer = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "drawer",
      focus: drawer,
    });
    const panel = vi.fn(() => true);
    const unregisterPanel = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "panel",
      focus: panel,
    });
    const leave = focusTerminalOnThreadEnter(ref);

    expect(drawer).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    leave();
    unregisterDrawer();
    unregisterPanel();
  });

  it("re-entering a thread after in-thread terminal actions focuses the drawer", () => {
    const ref = threadRef("re-entered");
    useTerminalUiStateStore.getState().ensureTerminal(ref, "drawer", { open: true, active: true });
    const drawer = vi.fn(() => true);
    const unregisterDrawer = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "drawer",
      focus: drawer,
    });

    const leaveFirst = focusTerminalOnThreadEnter(ref);
    focusTerminal(ref, "drawer");
    focusTerminalOnNavigation(ref, "drawer");
    leaveFirst();
    drawer.mockClear();
    const leaveSecond = focusTerminalOnThreadEnter(ref);

    expect(drawer).toHaveBeenCalledTimes(1);
    leaveSecond();
    unregisterDrawer();
  });

  it("a navigating handler's request only outranks the next thread entry", () => {
    const ref = threadRef("revisited");
    useTerminalUiStateStore.getState().ensureTerminal(ref, "drawer", { open: true, active: true });
    focusTerminalOnNavigation(ref, "panel");
    focusTerminalOnThreadEnter(threadRef("elsewhere"))();

    const drawer = vi.fn(() => true);
    const unregisterDrawer = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "drawer",
      focus: drawer,
    });
    const leave = focusTerminalOnThreadEnter(ref);

    expect(drawer).toHaveBeenCalledTimes(1);
    leave();
    unregisterDrawer();
  });

  it("focuses the panel terminal a closed surface falls back to", () => {
    const ref = threadRef("panel-fallback");
    const panel = useRightPanelStore.getState();
    panel.openTerminal(ref, "a");
    panel.open(ref, "diff");
    const { activeSurfaceId: diffSurfaceId } = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    );
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });
    expect(diffSurfaceId).not.toBeNull();

    useRightPanelStore.getState().closeSurface(ref, diffSurfaceId!);
    focusActivePanelTerminal(ref);

    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("closing a surface's last terminal focuses the terminal surface it falls back to", () => {
    const ref = threadRef("panel-terminal-fallback");
    const panel = useRightPanelStore.getState();
    panel.openTerminal(ref, "b");
    panel.openTerminal(ref, "a");
    const surfaceA = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    ).activeSurfaceId!;
    const focusB = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "b",
      focus: focusB,
    });

    panel.closeTerminal(ref, surfaceA, "a");
    focusActivePanelTerminal(ref);

    expect(focusB).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("refocuses the panel terminal only when closing changed the active surface", () => {
    const ref = threadRef("panel-after-close");
    const panel = useRightPanelStore.getState();
    panel.openTerminal(ref, "a");
    const terminalSurfaceId = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    ).activeSurfaceId!;
    panel.open(ref, "diff");
    const diffSurfaceId = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    ).activeSurfaceId!;
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    panel.activateSurface(ref, terminalSurfaceId);
    panel.closeSurface(ref, diffSurfaceId);
    focusPanelTerminalAfterClose(ref, terminalSurfaceId);
    expect(focus).not.toHaveBeenCalled();

    panel.open(ref, "diff");
    const reopenedDiffId = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    ).activeSurfaceId!;
    panel.closeSurface(ref, reopenedDiffId);
    focusPanelTerminalAfterClose(ref, reopenedDiffId);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });
});
