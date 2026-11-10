import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  consumePendingTerminalFocus,
  focusTerminal,
  focusTerminalViewport,
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
