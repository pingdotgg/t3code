/**
 * fork: f4 focus model — the composer must not eat the panel's keys.
 *
 * The live defect: with `document.activeElement` verifiably the changes
 * listbox, pressing `s`, `u` and `j` changed no git state; the characters were
 * inserted into the chat composer's contenteditable (it accumulated "jus") and
 * focus moved to the composer. `ChatView`'s type-to-focus runs in a window
 * CAPTURE-phase keydown listener and calls `preventDefault()` +
 * `stopPropagation()` after inserting, so the panel's bubble-phase handler —
 * and its `CHANGES_LIST_OWNED_KEYS` guard — never ran at all.
 *
 * The hole was structural, not a missing role: an `aria-activedescendant`
 * listbox keeps DOM focus on the CONTAINER, so the row's `role="option"` (which
 * upstream's guard does check) is never in `composedPath()`.
 */
import { describe, expect, it } from "vite-plus/test";

import { CHANGES_LIST_OWNED_KEYS } from "~/components/sourceControl/ChangesList";
import { HISTORY_LIST_OWNED_KEYS } from "~/components/sourceControl/HistoryList";

import {
  COMPOSER_KEY_OWNING_ATTRIBUTE,
  COMPOSER_KEY_OWNING_ROLES,
  COMPOSER_KEY_OWNING_SELECTOR,
  pathOwnsPrintableKeys,
} from "./composerTypeToFocus";

/** The composed path of a keydown on the changes listbox itself. */
const CHANGES_LISTBOX_PATH = ["listbox", null, null, null];
/** …and of one on the history listbox. */
const HISTORY_LISTBOX_PATH = ["listbox", null, null];
/** A keydown on the chat timeline: nobody owns these keys but the composer. */
const TIMELINE_PATH = [null, null, null];

describe("composer type-to-focus guard", () => {
  it("claims the roving listbox the panel focuses", () => {
    expect(pathOwnsPrintableKeys(CHANGES_LISTBOX_PATH)).toBe(true);
    expect(pathOwnsPrintableKeys(HISTORY_LISTBOX_PATH)).toBe(true);
  });

  it("leaves the ordinary chat surface alone, so typing still reaches the composer", () => {
    expect(pathOwnsPrintableKeys(TIMELINE_PATH)).toBe(false);
    expect(pathOwnsPrintableKeys([])).toBe(false);
  });

  it("does not claim a leaf role — upstream's own guard owns those", () => {
    // `option` and `button` deliberately stay out of the fork's set: they are
    // only ever the event target when they hold real DOM focus, and upstream
    // already bails on them.
    expect(pathOwnsPrintableKeys(["option", null])).toBe(false);
    expect(pathOwnsPrintableKeys(["button", null])).toBe(false);
  });

  it("claims a region that opted in by attribute", () => {
    // The source-control panel body owns `/` from anywhere inside it, and it is
    // a plain div with no role.
    expect(COMPOSER_KEY_OWNING_SELECTOR).toContain(`[${COMPOSER_KEY_OWNING_ATTRIBUTE}]`);
  });

  it("matches an ancestor listbox, not just the event target", () => {
    // A row's inner span can be the target when the listbox is hit with a
    // pointer first; the ancestor still owns the key.
    expect(pathOwnsPrintableKeys([null, null, "listbox", null])).toBe(true);
  });

  it("emits one attribute selector per role", () => {
    for (const role of COMPOSER_KEY_OWNING_ROLES) {
      expect(COMPOSER_KEY_OWNING_SELECTOR).toContain(`[role="${role}"]`);
    }
    expect(COMPOSER_KEY_OWNING_SELECTOR.split(",")).toHaveLength(
      COMPOSER_KEY_OWNING_ROLES.length + 1,
    );
  });

  it("covers modal surfaces, whose keys are never the composer's", () => {
    expect(pathOwnsPrintableKeys(["dialog"])).toBe(true);
    expect(pathOwnsPrintableKeys(["alertdialog"])).toBe(true);
  });
});

describe("panel-owned keys never reach the composer", () => {
  /**
   * The keys the two lists dispatch on. Every single-character one was being
   * typed into the composer instead; the multi-character ones (`ArrowDown`,
   * `Enter`, …) were never at risk, because type-to-focus requires
   * `key.length === 1`. Both are asserted so a future edit to either set is
   * caught by the same rule.
   */
  it("protects every key the changes list owns", () => {
    for (const key of CHANGES_LIST_OWNED_KEYS) {
      expect(
        { key, stolen: !pathOwnsPrintableKeys(CHANGES_LISTBOX_PATH) },
        `changes list key ${key}`,
      ).toEqual({ key, stolen: false });
    }
  });

  it("protects every key the history list owns", () => {
    for (const key of HISTORY_LIST_OWNED_KEYS) {
      expect(
        { key, stolen: !pathOwnsPrintableKeys(HISTORY_LISTBOX_PATH) },
        `history list key ${key}`,
      ).toEqual({ key, stolen: false });
    }
  });

  it("still owns the printable keys that made the panel look dead", () => {
    // The three from the live repro, in the order that spelled "jus".
    for (const key of ["j", "u", "s"]) {
      expect(CHANGES_LIST_OWNED_KEYS.has(key)).toBe(true);
    }
    expect(CHANGES_LIST_OWNED_KEYS.has("x")).toBe(true);
    expect(CHANGES_LIST_OWNED_KEYS.has("k")).toBe(true);
  });
});
