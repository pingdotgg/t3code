import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  consumePendingTerminalFocus,
  focusActivePanelTerminal,
  focusPanelTerminalAfterClose,
  focusTerminal,
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
