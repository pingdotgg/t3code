import { describe, expect, it } from "vitest";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "terminal.toggle",
          shortcut: {
            key: "j",
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
      ] satisfies ResolvedKeybindingsConfig,
      "terminal",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "terminal.toggle",
        key: "mod+j",
        when: "!terminalFocus",
        defaultKey: "mod+j",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
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

  it("formats static and project script command labels", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Command Palette: Toggle");
    expect(commandLabel("script.setup-db.run")).toBe("Run Script: Setup Db");
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(
      expect.arrayContaining(["terminalFocus", "terminalOpen", "modelPickerOpen", "true", "false"]),
    );
    expect(options).not.toContain("customModeActive");
  });

  it("builds command options from defaults and resolved project bindings", () => {
    const options = buildKeybindingCommandOptions([
      {
        command: "script.setup-db.run",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(options).toEqual(expect.arrayContaining(["chat.new", "script.setup-db.run"]));
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!terminalFocus && terminalFoc");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["terminalFoc"]);
  });

  it("marks each default shortcut for multi-binding commands as default", () => {
    const rows = buildKeybindingRows(
      [
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
          command: "chat.new",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows.map((row) => row.source)).toEqual(["Default", "Default"]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
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
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["Chat: New Local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: New Local"]);
  });
});
