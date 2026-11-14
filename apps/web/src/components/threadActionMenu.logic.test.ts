import { describe, expect, it } from "vite-plus/test";

import {
  buildFolderMenuItem,
  buildThreadActionMenuItems,
  folderFromMenuAction,
  folderTagChanges,
  parseFolderName,
  threadFolderNames,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
        folders: { names: ["Work"], threadTags: [[]] },
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "folder",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "folder",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("folderTagChanges", () => {
  it.each([
    {
      name: "moves into a new folder before leaving the others",
      tags: ["a", "b"],
      folder: "c",
      expected: [
        { tag: "c", tagged: true },
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    {
      name: "keeps the target and drops the rest",
      tags: ["a", "b"],
      folder: "b",
      expected: [{ tag: "a", tagged: false }],
    },
    { name: "is a no-op when already only in the folder", tags: ["a"], folder: "a", expected: [] },
    {
      name: "moves back to the project by removing every tag",
      tags: ["a", "b"],
      folder: null,
      expected: [
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    { name: "is a no-op back in the project", tags: [], folder: null, expected: [] },
  ])("$name", ({ tags, folder, expected }) => {
    expect(folderTagChanges(tags, folder)).toEqual(expected);
  });
});

describe("folder menu", () => {
  it("lists distinct folders by name", () => {
    expect(threadFolderNames([{ tags: ["b", "a"] }, {}, { tags: ["a", "C"] }])).toEqual([
      "a",
      "b",
      "C",
    ]);
  });

  it.each([
    ["  Work  ", "Work"],
    ["", null],
    ["   ", null],
    ["two\nlines", null],
    ["x".repeat(64), "x".repeat(64)],
    ["x".repeat(65), null],
  ])("parses folder name %j", (input, expected) => {
    expect(parseFolderName(input)).toBe(expected);
  });

  it.each([
    ["folder:Work", "Work"],
    ["folder:a:b", "a:b"],
    ["folder-none", null],
    ["folder-new", undefined],
    ["pin", undefined],
  ])("reads the target of %s", (action, expected) => {
    expect(folderFromMenuAction(action)).toBe(expected);
  });

  it("marks folders every selected thread shares and disables no-op moves", () => {
    const item = buildFolderMenuItem({
      names: ["a", "b"],
      threadTags: [["a"], ["a", "b"]],
    });
    expect(item.children?.map(({ id, checked, disabled }) => ({ id, checked, disabled }))).toEqual([
      { id: "folder:a", checked: true, disabled: false },
      { id: "folder:b", checked: false, disabled: false },
      { id: "folder-new", checked: undefined, disabled: undefined },
      { id: "folder-none", checked: undefined, disabled: false },
    ]);
    const single = buildFolderMenuItem({ names: ["a"], threadTags: [["a"]] });
    expect(single.children?.find((child) => child.id === "folder:a")?.disabled).toBe(true);
    const unfiled = buildFolderMenuItem({ names: [], threadTags: [[]] });
    expect(unfiled.children?.map((child) => [child.id, child.disabled])).toEqual([
      ["folder-new", undefined],
      ["folder-none", true],
    ]);
  });
});
