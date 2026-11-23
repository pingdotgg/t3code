import { ipcRenderer } from "electron";

import {
  PASSKEY_BRIDGE_ARGUMENT,
  PRIMARY_PASTE_DISABLED_ARGUMENT,
} from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}

if (process.argv.includes(PRIMARY_PASTE_DISABLED_ARGUMENT)) {
  // Same guard as the app preload: Blink pastes PRIMARY on an uncancelled middle mouseup.
  window.addEventListener(
    "mouseup",
    (event) => {
      if (event.button === 1) event.preventDefault();
    },
    true,
  );
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
if (process.platform === "darwin") {
  // Chromium holds Secure Event Input for a guest's focused password field even while the app
  // focuses something else, so one keeps focus only while this page has it (agents emulate focus).
  // An unfocused page fires no focus events, so script focus() is caught by wrapping it.
  const isPassword = (element: unknown): element is HTMLInputElement =>
    element instanceof HTMLInputElement && element.type === "password";
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    focus.call(this, options);
    if (isPassword(this) && !document.hasFocus()) this.blur();
  };
  window.addEventListener("blur", (event) => {
    if (event.target !== window) return;
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (isPassword(active)) active.blur();
  });
}
