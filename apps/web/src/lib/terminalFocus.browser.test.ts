import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

import {
  consumePendingTerminalFocus,
  focusTerminal,
  focusTerminalViewport,
  focusTerminalOnThreadEnter,
  focusTerminalOnNavigation,
  registerTerminalFocusTarget,
} from "./terminalFocus";

// The drawer's collapsed shape: a 0fr grid row that clips the viewport, which
// stays focusable, around a surface whose input refuses focus while hidden.
function mountClippedViewport() {
  const drawer = document.createElement("div");
  drawer.style.cssText = "display:grid;grid-template-rows:0fr;overflow:clip";
  const clip = document.createElement("div");
  clip.style.cssText = "min-height:0;overflow:clip";
  const mount = document.createElement("div");
  mount.tabIndex = -1;
  const input = document.createElement("textarea");
  mount.append(input);
  clip.append(mount);
  drawer.append(clip);
  document.body.append(drawer);
  const state = { visible: false };
  const surface = {
    focus() {
      if (state.visible) input.focus({ preventScroll: true });
    },
  };
  const focus = () =>
    focusTerminalViewport({ mount, surface, canOperate: true, visible: state.visible });
  return {
    input,
    state,
    focus,
    [Symbol.dispose]: () => drawer.remove(),
  };
}

describe("focusTerminalViewport", () => {
  it("keeps a request made while the drawer is hidden until it shows", () => {
    const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("hidden-drawer"));
    using viewport = mountClippedViewport();
    const unregister = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: "a",
      focus: viewport.focus,
    });
    using _unregister = { [Symbol.dispose]: unregister };

    focusTerminal(ref, "a");
    viewport.state.visible = true;
    consumePendingTerminalFocus(ref, "a");

    expect(document.activeElement).toBe(viewport.input);
  });
});

function mountThread(threadId: string, environmentId = "env") {
  const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  const root = document.createElement("div");
  const composer = document.createElement("textarea");
  composer.ariaLabel = "Composer";
  composer.dataset.workspaceArea = "composer";
  root.append(composer);
  document.body.append(root);
  const drawerState = { visible: true };
  const mountTerminal = (id: string) => {
    const input = document.createElement("textarea");
    input.ariaLabel = id;
    root.append(input);
    const unregister = registerTerminalFocusTarget({
      threadRef: ref,
      terminalId: id,
      element: input,
      focus: () => {
        if (id === "drawer" && !drawerState.visible) return false;
        input.focus();
        return document.activeElement === input;
      },
    });
    return {
      input,
      [Symbol.dispose]() {
        unregister();
        input.remove();
      },
    };
  };
  useTerminalUiStateStore.getState().ensureTerminal(ref, "drawer", { open: true, active: true });
  useRightPanelStore.getState().openTerminal(ref, "panel");
  return {
    ref,
    root,
    composer,
    drawerState,
    mountTerminal,
    enter: () => focusTerminalOnThreadEnter(ref, { root, focusComposer: () => composer.focus() }),
    [Symbol.dispose]: () => root.remove(),
  };
}

describe("thread focus restoration", () => {
  it.each(["composer", "drawer", "panel", "remounted composer"] as const)(
    "restores %s focus when returning to a thread with both terminals open",
    (control) => {
      using thread = mountThread(`return-${control}`);
      using drawer = thread.mountTerminal("drawer");
      using panel = thread.mountTerminal("panel");
      const leave = thread.enter();
      if (control === "panel") document.body.append(panel.input);
      const remount = control === "remounted composer";
      const initial =
        control === "composer" || remount
          ? thread.composer
          : control === "drawer"
            ? drawer.input
            : panel.input;
      initial.focus();
      expect(document.activeElement).toBe(initial);
      if (remount) focusTerminal(thread.ref, "not-ready");
      leave();
      thread.root.hidden = true;
      if (!remount)
        focusTerminalOnThreadEnter(
          scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("other-thread")),
        )();
      drawer[Symbol.dispose]();
      panel[Symbol.dispose]();
      if (remount) thread.root.remove();
      using remountedThread = remount ? mountThread(`return-${control}`) : undefined;
      const returnedThread = remountedThread ?? thread;
      returnedThread.root.hidden = false;
      using remountedDrawer = returnedThread.mountTerminal("drawer");
      using remountedPanel = returnedThread.mountTerminal("panel");
      if (control === "panel") document.body.append(remountedPanel.input);
      using _leave = { [Symbol.dispose]: returnedThread.enter() };
      const expected =
        control === "composer" || remount
          ? returnedThread.composer
          : control === "drawer"
            ? remountedDrawer.input
            : remountedPanel.input;

      expect(document.activeElement).toBe(expected);
    },
  );

  it("keeps an explicit terminal navigation request ahead of remembered composer focus", () => {
    using thread = mountThread("explicit-reveal");
    using _drawer = thread.mountTerminal("drawer");
    using panel = thread.mountTerminal("panel");
    const leave = thread.enter();
    thread.composer.focus();
    leave();
    focusTerminalOnThreadEnter(
      scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("before-reveal")),
    )();

    focusTerminalOnNavigation(thread.ref, "panel");
    using _leave = { [Symbol.dispose]: thread.enter() };

    expect(document.activeElement).toBe(panel.input);
  });

  it("does not share focus history between matching thread ids in different environments", () => {
    using first = mountThread("shared-id", "first");
    using _firstDrawer = first.mountTerminal("drawer");
    const leaveFirst = first.enter();
    first.composer.focus();
    leaveFirst();
    using second = mountThread("shared-id", "second");
    using secondDrawer = second.mountTerminal("drawer");
    using secondPanel = second.mountTerminal("panel");
    const leaveSecond = second.enter();
    expect(document.activeElement).toBe(secondDrawer.input);
    secondPanel.input.focus();
    leaveSecond();
    using _leave = { [Symbol.dispose]: first.enter() };

    expect(document.activeElement).toBe(first.composer);
  });

  it("keeps an explicit drawer-open request while its viewport becomes visible", () => {
    using thread = mountThread("drawer-open");
    using drawer = thread.mountTerminal("drawer");
    const leave = thread.enter();
    thread.composer.focus();
    thread.drawerState.visible = false;
    useTerminalUiStateStore.getState().setTerminalOpen(thread.ref, false);
    focusTerminal(thread.ref, "drawer");
    useTerminalUiStateStore.getState().setTerminalOpen(thread.ref, true);
    leave();
    using _leave = { [Symbol.dispose]: thread.enter() };
    thread.drawerState.visible = true;
    consumePendingTerminalFocus(thread.ref, "drawer");

    expect(document.activeElement).toBe(drawer.input);
  });

  it.each(["viewport", "close button", "header toggle"] as const)(
    "falls back to the composer when the drawer closes from its %s",
    (control) => {
      using thread = mountThread(`closed-remembered-${control}`);
      using drawer = thread.mountTerminal("drawer");
      const close = document.createElement("button");
      if (control === "close button") close.dataset.terminalOwner = "drawer";
      thread.root.append(close);
      const leave = thread.enter();
      if (control !== "viewport") close.focus();
      else expect(document.activeElement).toBe(drawer.input);
      leave();
      useTerminalUiStateStore.getState().setTerminalOpen(thread.ref, false);
      thread.drawerState.visible = false;
      using _leave = { [Symbol.dispose]: thread.enter() };

      expect(document.activeElement).toBe(thread.composer);
    },
  );
});
