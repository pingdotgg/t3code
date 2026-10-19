import { afterEach, describe, expect, it } from "vite-plus/test";

import { shouldTypeToFocusComposer } from "./composerFocusRedirect";

// composedPath() is only populated while the event is dispatching, so decide
// inside a window capture listener the way the chat view does.
function typeOn(target: Element, key: string): boolean {
  let redirected = false;
  const listener = (event: KeyboardEvent) => {
    redirected = shouldTypeToFocusComposer(event);
  };
  window.addEventListener("keydown", listener, { capture: true });
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
  window.removeEventListener("keydown", listener, { capture: true });
  return redirected;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("shouldTypeToFocusComposer", () => {
  it("sends letters typed on the chat to the composer", () => {
    const chat = document.createElement("div");
    document.body.append(chat);

    expect(typeOn(chat, "a")).toBe(true);
  });

  it("keeps letters typed on the device screen on the device", () => {
    const deviceScreen = document.createElement("div");
    deviceScreen.setAttribute("role", "application");
    deviceScreen.tabIndex = 0;
    document.body.append(deviceScreen);

    expect(typeOn(deviceScreen, "a")).toBe(false);
  });
});
