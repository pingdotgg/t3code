// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { launcherShortcutBlockedByOverlay } from "./RightPanelTabs";

const POPUP_SLOTS = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
] as const;

/** Mount a popup slot in the document in a closed, open, or closing state. */
function mountPopup(slot: string, state: "closed" | "open" | "ending"): HTMLElement {
  const popup = document.createElement("div");
  popup.dataset.slot = slot;
  if (state === "closed") popup.dataset.closed = "";
  if (state === "open") popup.dataset.open = "";
  if (state === "ending") popup.dataset.endingStyle = "";
  document.body.append(popup);
  return popup;
}

describe("launcher shortcut overlays", () => {
  it("ignores a closed popup that stays mounted", () => {
    for (const slot of POPUP_SLOTS) {
      document.body.replaceChildren();
      mountPopup(slot, "closed");
      expect(launcherShortcutBlockedByOverlay(), slot).toBe(false);
    }
  });

  it("blocks while a popup is open or animating closed", () => {
    for (const slot of POPUP_SLOTS) {
      for (const state of ["open", "ending"] as const) {
        document.body.replaceChildren();
        mountPopup(slot, state);
        expect(launcherShortcutBlockedByOverlay(), `${slot} ${state}`).toBe(true);
      }
    }
  });

  it("keeps blocking when a closed mounted menu sits beside an open one", () => {
    document.body.replaceChildren();
    mountPopup("menu-popup", "closed");
    mountPopup("menu-popup", "open");
    expect(launcherShortcutBlockedByOverlay()).toBe(true);
  });
});
