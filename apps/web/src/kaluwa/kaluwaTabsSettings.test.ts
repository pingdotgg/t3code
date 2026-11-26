import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { moveThreadTabRulesLast } from "./kaluwaThreadTabShortcuts";
import {
  DEFAULT_KALUWA_TABS_SETTINGS,
  kaluwaTabsStyleVariables,
  parseKaluwaTabsSettings,
} from "./kaluwaTabsSettings";

describe("parseKaluwaTabsSettings", () => {
  it("defaults to the theme lab's pill tabs", () => {
    expect(parseKaluwaTabsSettings(null)).toEqual(DEFAULT_KALUWA_TABS_SETTINGS);
    expect(DEFAULT_KALUWA_TABS_SETTINGS).toMatchObject({ style: "pill", radius: 8, height: 30 });
  });

  it("keeps valid fields, clamps sizes and defaults the rest", () => {
    expect(
      parseKaluwaTabsSettings(
        JSON.stringify({ enabled: true, style: "folder", radius: 99, height: 10.6 }),
      ),
    ).toEqual({
      enabled: true,
      style: "folder",
      radius: 16,
      height: 24,
      openIn: "new-tab",
      groupByProject: true,
    });
    expect(parseKaluwaTabsSettings(JSON.stringify({ style: "tabs", enabled: "yes" }))).toEqual(
      DEFAULT_KALUWA_TABS_SETTINGS,
    );
    expect(parseKaluwaTabsSettings("not json")).toEqual(DEFAULT_KALUWA_TABS_SETTINGS);
  });

  it("caps the radius at half the height", () => {
    expect(
      kaluwaTabsStyleVariables({
        enabled: true,
        style: "pill",
        radius: 16,
        height: 24,
        openIn: "new-tab",
        groupByProject: true,
      }),
    ).toEqual({ "--kaluwa-tab-radius": "12px", "--kaluwa-tab-height": "24px" });
  });
});

describe("thread tab shortcuts", () => {
  const key = (
    init: Partial<ShortcutEventLike> & { key: string; code: string },
  ): ShortcutEventLike => ({
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });
  const options = (kaluwaTabs: boolean) => ({
    platform: "MacIntel",
    context: { kaluwaTabs, kaluwaPanelFocus: false, isDesktop: true, modelPickerOpen: false },
  });
  // The server puts new defaults before a user's existing rules.
  const backfilled = compileResolvedKeybindingsConfig([
    ...DEFAULT_KEYBINDINGS.filter((rule) => rule.command.startsWith("threadTab.")),
    ...DEFAULT_KEYBINDINGS.filter((rule) => !rule.command.startsWith("threadTab.")),
  ]);
  const rules = moveThreadTabRulesLast(backfilled);

  it("win over the thread jumps and right panel keys while tabs show", () => {
    expect(resolveShortcutCommand(key({ key: "1", code: "Digit1" }), rules, options(true))).toBe(
      "threadTab.jump.1",
    );
    expect(resolveShortcutCommand(key({ key: "w", code: "KeyW" }), rules, options(true))).toBe(
      "threadTab.close",
    );
    expect(
      resolveShortcutCommand(key({ key: "1", code: "Digit1" }), backfilled, options(true)),
    ).toBe("thread.jump.1");
  });

  it("leave the existing bindings alone without tabs", () => {
    expect(resolveShortcutCommand(key({ key: "1", code: "Digit1" }), rules, options(false))).toBe(
      "thread.jump.1",
    );
    expect(resolveShortcutCommand(key({ key: "w", code: "KeyW" }), rules, options(false))).toBe(
      "rightPanel.close",
    );
  });

  it("leave Cmd+W to the right panel while it has focus", () => {
    expect(
      resolveShortcutCommand(key({ key: "w", code: "KeyW" }), rules, {
        ...options(true),
        context: { ...options(true).context, kaluwaPanelFocus: true },
      }),
    ).toBe("rightPanel.close");
  });

  it("switch tabs with Ctrl+Tab", () => {
    const ctrlTab = key({ key: "Tab", code: "Tab", metaKey: false, ctrlKey: true });
    expect(resolveShortcutCommand(ctrlTab, rules, options(true))).toBe("threadTab.next");
  });
});
