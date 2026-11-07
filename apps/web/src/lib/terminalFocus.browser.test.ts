import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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

function mountThreadInputs(threadId: string, environmentId = "env") {
  const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  const thread = document.createElement("div");
  thread.dataset.threadFocusKey = scopedThreadKey(ref);
  const composer = document.createElement("textarea");
  composer.dataset.testid = "composer-editor";
  const terminal = document.createElement("textarea");
  terminal.dataset.threadTerminalId = "a";
  const other = document.createElement("button");
  thread.append(composer, terminal);
  document.body.append(thread, other);
  useTerminalUiStateStore.getState().ensureTerminal(ref, "a", { open: true, active: true });
  const state = { canFocus: true };
  const unregister = registerTerminalFocusTarget({
    threadRef: ref,
    terminalId: "a",
    focus: () => {
      if (!state.canFocus) return false;
      terminal.focus();
      return document.activeElement === terminal;
    },
  });
  return {
    ref,
    composer,
    terminal,
    other,
    state,
    focusComposer: () => composer.focus(),
    [Symbol.dispose]: () => {
      unregister();
      thread.remove();
      other.remove();
    },
  };
}
describe("focusTerminalViewport", () => {
  it("restores the composer after leaving a thread with its drawer open", () => {
    using inputs = mountThreadInputs("composer-return");
    const leave = focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer);
    inputs.composer.focus();
    leave();
    inputs.other.focus();
    using _return = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer),
    };

    expect(document.activeElement).toBe(inputs.composer);
  });

  it("restores the terminal the user focused instead of the drawer's active terminal", () => {
    using inputs = mountThreadInputs("panel-return");
    useTerminalUiStateStore.getState().ensureTerminal(inputs.ref, "drawer", { active: true });
    const leave = focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer);
    inputs.terminal.focus();
    leave();
    inputs.other.focus();
    using _return = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer),
    };

    expect(document.activeElement).toBe(inputs.terminal);
  });

  it("keeps an explicit terminal navigation ahead of remembered composer focus", () => {
    using inputs = mountThreadInputs("explicit-return");
    const leave = focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer);
    inputs.composer.focus();
    leave();
    inputs.other.focus();
    focusTerminalOnNavigation(inputs.ref, "a");
    using _return = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer),
    };

    expect(document.activeElement).toBe(inputs.terminal);
  });

  it("falls back to the composer without a delayed request when the old terminal cannot focus", () => {
    using inputs = mountThreadInputs("unavailable-return");
    const leave = focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer);
    inputs.terminal.focus();
    leave();
    inputs.other.focus();
    inputs.state.canFocus = false;
    using _return = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer),
    };
    expect(document.activeElement).toBe(inputs.composer);

    inputs.state.canFocus = true;
    consumePendingTerminalFocus(inputs.ref, "a");
    expect(document.activeElement).toBe(inputs.composer);
  });

  it("does not share focus history between environments with the same thread ID", () => {
    using first = mountThreadInputs("same-thread", "first-environment");
    using second = mountThreadInputs("same-thread", "second-environment");
    const leave = focusTerminalOnThreadEnter(first.ref, first.focusComposer);
    first.composer.focus();
    leave();
    first.other.focus();
    using _return = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(second.ref, second.focusComposer),
    };

    expect(document.activeElement).toBe(second.terminal);
  });

  it("drops a pending terminal request when the user picks another input", () => {
    using inputs = mountThreadInputs("pending-composer");
    using _leave = {
      [Symbol.dispose]: focusTerminalOnThreadEnter(inputs.ref, inputs.focusComposer),
    };
    inputs.state.canFocus = false;
    focusTerminal(inputs.ref, "a");
    inputs.composer.focus();
    inputs.state.canFocus = true;
    consumePendingTerminalFocus(inputs.ref, "a");

    expect(document.activeElement).toBe(inputs.composer);
  });
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
