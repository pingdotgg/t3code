import type { DesktopWindowContextMenuRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWindowContextMenu,
  makeInPageContextMenus,
  toNativeContextMenuTemplate,
  type WindowContextMenuAction,
} from "./WindowContextMenu.ts";

const editFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: true,
  canPaste: false,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
};

const misspelled = buildWindowContextMenu(
  {
    misspelledWord: "teh",
    dictionarySuggestions: ["the", "ten"],
    mediaType: "none",
    editFlags,
  },
  true,
);

describe("WindowContextMenu", () => {
  it("groups spelling, link, and editing entries with one separator between groups", () => {
    expect(misspelled.map((entry) => [entry.label, entry.enabled, entry.separatorBefore])).toEqual([
      ["the", true, false],
      ["ten", true, false],
      ["Copy Link", true, true],
      ["Cut", false, true],
      ["Copy", true, false],
      ["Paste", false, false],
      ["Select all", true, false],
    ]);
    expect(toNativeContextMenuTemplate(misspelled, () => {}).slice(2, 5)).toMatchObject([
      { type: "separator" },
      { label: "Copy Link" },
      { type: "separator" },
    ]);
  });

  it("runs the picked entry once, and ignores disabled, stale, and unknown answers", () => {
    const sent: DesktopWindowContextMenuRequest[] = [];
    const ran: WindowContextMenuAction[] = [];
    const menus = makeInPageContextMenus((request) => sent.push(request));
    const run = (action: WindowContextMenuAction) => ran.push(action);

    menus.show(misspelled, { x: 10, y: 20 }, run);
    menus.show(misspelled, { x: 10, y: 20 }, run);
    const [stale, current] = sent;
    expect(current?.items[3]).toEqual({
      id: "3",
      label: "Cut",
      shortcut: "Ctrl+X",
      disabled: true,
      separatorBefore: true,
    });

    menus.resolve({ requestId: stale?.requestId, itemId: "0" });
    menus.resolve({ requestId: current?.requestId, itemId: "99" });
    expect(ran).toEqual([]);

    menus.show(misspelled, { x: 10, y: 20 }, run);
    menus.resolve({ requestId: sent[2]?.requestId, itemId: "3" });
    menus.show(misspelled, { x: 10, y: 20 }, run);
    menus.resolve({ requestId: sent[3]?.requestId, itemId: "0" });
    menus.resolve({ requestId: sent[3]?.requestId, itemId: "0" });
    expect(ran).toEqual([{ type: "replace-misspelling", word: "the" }]);
  });
});
