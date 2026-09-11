import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuKeyAction, type ComposerMenuKeyAction } from "./composerMenuKeyAction";

type Params = Parameters<typeof resolveComposerMenuKeyAction>[0];

describe("resolveComposerMenuKeyAction", () => {
  it.each<[string, Params, ComposerMenuKeyAction | null]>([
    [
      "ArrowDown with items highlights down",
      { key: "ArrowDown", altKey: false, itemCount: 3, activeItemType: null },
      { kind: "highlight", direction: "ArrowDown" },
    ],
    [
      "ArrowUp with items highlights up",
      { key: "ArrowUp", altKey: false, itemCount: 3, activeItemType: null },
      { kind: "highlight", direction: "ArrowUp" },
    ],
    [
      "ArrowDown with no items does nothing",
      { key: "ArrowDown", altKey: false, itemCount: 0, activeItemType: null },
      null,
    ],
    [
      "ArrowUp with no items does nothing",
      { key: "ArrowUp", altKey: false, itemCount: 0, activeItemType: null },
      null,
    ],
    [
      "Alt+Enter on a skill pins the mode",
      { key: "Enter", altKey: true, itemCount: 1, activeItemType: "skill" },
      { kind: "pin-mode" },
    ],
    [
      "Alt+Enter on a path selects",
      { key: "Enter", altKey: true, itemCount: 1, activeItemType: "path" },
      { kind: "select" },
    ],
    [
      "Alt+Enter on a slash command selects",
      { key: "Enter", altKey: true, itemCount: 1, activeItemType: "slash-command" },
      { kind: "select" },
    ],
    [
      "Alt+Enter on a provider slash command selects",
      { key: "Enter", altKey: true, itemCount: 1, activeItemType: "provider-slash-command" },
      { kind: "select" },
    ],
    [
      "plain Enter on a skill selects",
      { key: "Enter", altKey: false, itemCount: 1, activeItemType: "skill" },
      { kind: "select" },
    ],
    [
      "Alt+Tab on a skill selects because only Enter pins",
      { key: "Tab", altKey: true, itemCount: 1, activeItemType: "skill" },
      { kind: "select" },
    ],
    [
      "Enter with no active item does nothing",
      { key: "Enter", altKey: false, itemCount: 0, activeItemType: null },
      null,
    ],
    [
      "Tab with no active item does nothing",
      { key: "Tab", altKey: false, itemCount: 0, activeItemType: null },
      null,
    ],
  ])("%s", (_name, params, expected) => {
    const action = resolveComposerMenuKeyAction(params);

    if (expected === null) {
      expect(action).toBeNull();
    } else {
      expect(action).toEqual(expected);
    }
  });
});
