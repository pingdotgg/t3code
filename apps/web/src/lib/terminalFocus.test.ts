import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  consumePendingTerminalFocus,
  focusActivePanelTerminal,
  focusPanelTerminalAfterClose,
  focusTerminal,
  focusTerminalOnNavigation,
  registerTerminalFocusTarget,
  restoreFocusOnThreadEnter,
} from "./terminalFocus";

const threadRef = (threadId: string) =>
  scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(threadId));

// Node has no DOM; entry only listens on the root's document for focus changes.
const enterThreadWith = (ref: ReturnType<typeof threadRef>, focusComposer: () => void) =>
  restoreFocusOnThreadEnter(ref, {
    root: {
      ownerDocument: Object.assign(new EventTarget(), { activeElement: null }),
    } as unknown as HTMLElement,
    focusComposer,
  });
const enterThread = (ref: ReturnType<typeof threadRef>) => enterThreadWith(ref, () => {});

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
    useRightPanelStore.getState().openTerminal(ref, "a");
    focusActivePanelTerminal(ref);
    useRightPanelStore.getState().setTerminalDrawerOpen(ref, false);
    focusActivePanelTerminal(ref);

    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  // The drawer is open across threads, so entering one focuses the composer, not its terminal.
  it("entering a thread with the drawer open focuses the composer", () => {
    const ref = threadRef("entered");
    useRightPanelStore.getState().openTerminal(ref, "a");
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });
    const composer = vi.fn();

    const leave = enterThreadWith(ref, composer);

    expect(focus).not.toHaveBeenCalled();
    expect(composer).toHaveBeenCalledTimes(1);
    leave();
    unregister();
  });

  it("entering a thread keeps the request its navigating handler made", () => {
    const ref = threadRef("revealed");
    useRightPanelStore.getState().openTerminal(ref, "drawer");
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
    const composer = vi.fn();
    const leave = enterThreadWith(ref, composer);

    expect(drawer).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    expect(composer).not.toHaveBeenCalled();
    leave();
    unregisterDrawer();
    unregisterPanel();
  });

  it("re-entering a thread after in-thread terminal actions is not a navigation", () => {
    const ref = threadRef("re-entered");
    useRightPanelStore.getState().openTerminal(ref, "drawer");
    const drawer = vi.fn(() => true);
    const unregisterDrawer = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "drawer",
      focus: drawer,
    });

    const leaveFirst = enterThread(ref);
    focusTerminal(ref, "drawer");
    focusTerminalOnNavigation(ref, "drawer");
    leaveFirst();
    drawer.mockClear();
    const composer = vi.fn();
    const leaveSecond = enterThreadWith(ref, composer);

    expect(composer).toHaveBeenCalledTimes(1);
    leaveSecond();
    unregisterDrawer();
  });

  it("a navigating handler's request only outranks the next thread entry", () => {
    const ref = threadRef("revisited");
    useRightPanelStore.getState().openTerminal(ref, "drawer");
    focusTerminalOnNavigation(ref, "panel");
    enterThread(threadRef("elsewhere"))();

    const panel = vi.fn(() => true);
    const unregisterPanel = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "panel",
      focus: panel,
    });
    const composer = vi.fn();
    const leave = enterThreadWith(ref, composer);

    expect(panel).not.toHaveBeenCalled();
    expect(composer).toHaveBeenCalledTimes(1);
    leave();
    unregisterPanel();
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
    ).activeTerminalSurfaceId!;
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

  it("refocuses the drawer terminal only when closing changed the active sub-tab", () => {
    const ref = threadRef("panel-after-close");
    const panel = useRightPanelStore.getState();
    panel.openTerminal(ref, "a");
    panel.openTerminal(ref, "b");
    panel.open(ref, "diff");
    const focus = vi.fn(() => true);
    const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "a", focus });

    panel.closeSurface(ref, "diff");
    focusPanelTerminalAfterClose(ref, "terminal:b");
    expect(focus).not.toHaveBeenCalled();

    panel.closeSurface(ref, "terminal:b");
    focusPanelTerminalAfterClose(ref, "terminal:b");
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });
});
