import { assert, describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

import { resolveShortcutCommand } from "../../keybindings";

import {
  buildKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("keeps sibling row identities when a saved binding moves to the end", () => {
    const bindings = compileResolvedKeybindingsConfig([
      { command: "chat.new", key: "mod+n" },
      { command: "terminal.toggle", key: "mod+j" },
      { command: "terminal.toggle", key: "mod+k", when: "terminalFocus" },
    ]);
    const before = buildKeybindingRows(bindings);
    const after = buildKeybindingRows([
      ...bindings.slice(1),
      ...compileResolvedKeybindingsConfig([{ command: "chat.new", key: "mod+shift+n" }]),
    ]);

    expect(after.filter((row) => row.command === "terminal.toggle").map((row) => row.id)).toEqual(
      before.filter((row) => row.command === "terminal.toggle").map((row) => row.id),
    );
    expect(after.find((row) => row.command === "chat.new")?.id).not.toBe(
      before.find((row) => row.command === "chat.new")?.id,
    );
  });

  it("shares a stable editor for resolved duplicates but separates commands, shortcuts, and conditions", () => {
    const bindings = compileResolvedKeybindingsConfig([
      { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+escape", when: "(terminalFocus)" },
      { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
      { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
    ]);
    const rows = buildKeybindingRows(bindings);
    expect(rows.map(({ command, key, when }) => ({ command, key, when }))).toEqual([
      { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(rows.find((row) => row.command === "chat.new")?.conflicts).toEqual(["Terminal: Toggle"]);
    expect(buildKeybindingRows(bindings.slice(1)).map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it("waits for a key when only a modifier is pressed", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "Meta",
          code: "MetaLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBeNull();
  });

  it.each([
    ["@", "Digit2", "mod+shift+2"],
    ['"', "Digit2", "mod+shift+2"],
    ["@", "Quote", "mod+shift+'"],
  ])("captures %s at %s by physical key", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key,
          code,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it("records layout punctuation while preserving physical Alt shortcuts; saved bindings still trigger", () => {
    for (const { key, code, altKey = false, shiftKey, expected, defaultInput } of [
      { key: "#", code: "Backslash", shiftKey: false, expected: "#", defaultInput: "\\" },
      {
        key: "'",
        code: "Backslash",
        shiftKey: true,
        expected: "shift+'",
        defaultInput: "shift+\\",
      },
      {
        key: "¡",
        code: "Digit1",
        altKey: true,
        shiftKey: false,
        expected: "alt+1",
        defaultInput: "alt+1",
      },
    ]) {
      const pressed = {
        key,
        code,
        metaKey: false,
        ctrlKey: false,
        altKey,
        shiftKey,
      };
      expect(keybindingFromKeyboardEvent(pressed, "MacIntel")).toBe(defaultInput);
      const input = keybindingFromKeyboardEvent(pressed, "MacIntel", { layoutCharacter: true });
      expect(input).toBe(expected);
      assert(input);
      const shortcut = parseKeybindingShortcut(input);
      assert(shortcut);
      expect(
        resolveShortcutCommand(pressed, [{ command: "chat.new", shortcut }], {
          platform: "MacIntel",
        }),
      ).toBe("chat.new");
    }
  });

  it("captures Latin layout keys instead of their punctuation position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "m",
          code: "Semicolon",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+m");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows([
      {
        command: "chat.new",
        shortcut: {
          key: "n",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        whenAst: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
      {
        command: "chat.newLocal",
        shortcut: {
          key: "n",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        whenAst: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(rows[0]?.conflicts).toEqual(["Chat: New Local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: New Local"]);
  });

  it.each([
    { platform: "Linux x86_64", ctrl: ["Chat: New"], meta: [] },
    { platform: "Win32", ctrl: ["Chat: New"], meta: [] },
    { platform: "MacIntel", ctrl: [], meta: ["Chat: New"] },
  ])("resolves mod to the $platform modifier when reporting conflicts", (expected) => {
    const rows = buildKeybindingRows(
      compileResolvedKeybindingsConfig([
        { command: "chat.new", key: "mod+k" },
        { command: "chat.newLocal", key: "ctrl+k" },
        { command: "thread.copyReference", key: "meta+k" },
      ]),
      expected.platform,
    );
    const conflictsFor = (key: string) => rows.find((row) => row.key === key)?.conflicts;

    expect(conflictsFor("ctrl+k")).toEqual(expected.ctrl);
    expect(conflictsFor("meta+k")).toEqual(expected.meta);
    expect(
      keybindingConflictLabels(rows, { rowId: "new", key: "ctrl+k", when: "" }, expected.platform),
    ).toEqual(["Chat: New Local", ...expected.ctrl].toSorted());
  });

  it("keeps mod and ctrl shortcuts apart when their when contexts differ", () => {
    const rows = buildKeybindingRows(
      compileResolvedKeybindingsConfig([
        { command: "chat.new", key: "mod+k", when: "!terminalFocus" },
        { command: "chat.newLocal", key: "ctrl+k", when: "terminalFocus" },
      ]),
      "Linux x86_64",
    );

    expect(rows.map((row) => row.conflicts)).toEqual([[], []]);
  });
});
