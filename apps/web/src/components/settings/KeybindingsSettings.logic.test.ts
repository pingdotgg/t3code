import { describe, expect, it } from "vitest";
import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  buildKeybindingRows,
  commandLabel,
  defaultRulesForCommand,
  encodeShortcutKey,
  filterKeybindingRows,
  keybindingFromKeyboardEvent,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

const MAC = "MacIntel";
const WIN = "Win32";

function shortcut(overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

describe("commandLabel", () => {
  it("humanizes dotted static commands", () => {
    expect(commandLabel("terminal.toggle")).toBe("Terminal: Toggle");
    expect(commandLabel("chat.newLocal")).toBe("Chat: New Local");
    expect(commandLabel("thread.jump.1")).toBe("Thread: Jump: 1");
  });

  it("labels project script commands by script id", () => {
    expect(commandLabel("script.my-script.run")).toBe("Run Script: My Script");
  });

  it("falls back to title-cased segments for unknown commands", () => {
    expect(commandLabel("mystery")).toBe("Mystery");
  });
});

describe("encodeShortcutKey", () => {
  it("encodes modifiers in canonical order", () => {
    expect(encodeShortcutKey(shortcut({ key: "k", modKey: true, shiftKey: true }))).toBe(
      "mod+shift+k",
    );
  });

  it("round-trips space and escape through server spellings", () => {
    expect(encodeShortcutKey(shortcut({ key: " ", modKey: true }))).toBe("mod+space");
    expect(encodeShortcutKey(shortcut({ key: "escape", modKey: false }))).toBe("esc");
  });

  it("encodes a literal plus key", () => {
    expect(encodeShortcutKey(shortcut({ key: "+" }))).toBe("mod++");
  });
});

describe("whenAstToExpression", () => {
  it("renders missing conditions as empty", () => {
    expect(whenAstToExpression(undefined)).toBe("");
  });

  it("renders identifiers and negation", () => {
    expect(whenAstToExpression({ type: "identifier", name: "terminalFocus" })).toBe(
      "terminalFocus",
    );
    expect(
      whenAstToExpression({
        type: "not",
        node: { type: "identifier", name: "terminalFocus" },
      }),
    ).toBe("!terminalFocus");
  });

  it("renders boolean groups, parenthesizing only nested groups", () => {
    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "terminalFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "previewFocus" },
        },
      }),
    ).toBe("terminalFocus && !previewFocus");
    expect(
      whenAstToExpression({
        type: "or",
        left: {
          type: "and",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "previewFocus" },
        },
        right: { type: "identifier", name: "modelPickerOpen" },
      }),
    ).toBe("(terminalFocus && previewFocus) || modelPickerOpen");
  });
});

describe("keybindingFromKeyboardEvent", () => {
  function event(overrides = {}) {
    return {
      key: "j",
      code: "KeyJ",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    };
  }

  it("maps meta to mod on macOS and ctrl to mod elsewhere", () => {
    expect(keybindingFromKeyboardEvent(event({ metaKey: true }), MAC)).toBe("mod+j");
    expect(keybindingFromKeyboardEvent(event({ ctrlKey: true }), WIN)).toBe("mod+j");
  });

  it("keeps the non-mod platform key explicit", () => {
    expect(keybindingFromKeyboardEvent(event({ ctrlKey: true }), MAC)).toBe("ctrl+j");
    expect(keybindingFromKeyboardEvent(event({ metaKey: true }), WIN)).toBe("meta+j");
  });

  it("includes alt and shift", () => {
    expect(keybindingFromKeyboardEvent(event({ metaKey: true, shiftKey: true }), MAC)).toBe(
      "mod+shift+j",
    );
  });

  it("returns null for modifier-only presses", () => {
    for (const key of ["Control", "Shift", "Alt", "Meta"]) {
      expect(keybindingFromKeyboardEvent(event({ key }), MAC)).toBeNull();
    }
  });

  it("supports space, arrows, and function keys", () => {
    expect(keybindingFromKeyboardEvent(event({ key: " " }), MAC)).toBe("space");
    expect(keybindingFromKeyboardEvent(event({ key: "ArrowLeft", code: "ArrowLeft" }), WIN)).toBe(
      "arrowleft",
    );
    expect(keybindingFromKeyboardEvent(event({ key: "F5", code: "F5" }), WIN)).toBe("f5");
  });

  it("returns null for keys with no binding spelling", () => {
    expect(
      keybindingFromKeyboardEvent(event({ key: "CapsLock", code: "CapsLock" }), MAC),
    ).toBeNull();
  });
});

describe("defaultRulesForCommand", () => {
  it("returns mirrored server defaults for known commands", () => {
    const rules = defaultRulesForCommand("terminal.toggle");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ key: "mod+j", command: "terminal.toggle" });
  });

  it("returns every default rule for multi-bound commands", () => {
    expect(defaultRulesForCommand("chat.new")).toHaveLength(2);
  });

  it("returns no defaults for project script commands", () => {
    expect(defaultRulesForCommand("script.setup.run")).toEqual([]);
  });
});

describe("buildKeybindingRows", () => {
  const config = [
    { command: "terminal.toggle", shortcut: shortcut({ key: "j" }) },
    {
      command: "chat.new",
      shortcut: shortcut({ key: "n" }),
      whenAst: { type: "identifier", name: "terminalFocus" } as const,
    },
    { command: "script.setup.run", shortcut: shortcut({ key: "r" }) },
  ] satisfies ResolvedKeybindingsConfig;

  it("marks rules matching server defaults as Default and the rest Custom", () => {
    const rows = buildKeybindingRows(config);
    expect(rows.find((row) => row.command === "terminal.toggle")?.source).toBe("Default");
    expect(rows.find((row) => row.command === "chat.new")?.source).toBe("Custom");
    expect(rows.find((row) => row.command === "script.setup.run")?.source).toBe("Custom");
  });

  it("sorts rows by human label", () => {
    const labels = buildKeybindingRows(config).map((row) => row.label);
    expect(labels).toEqual([...labels].sort((left, right) => left.localeCompare(right)));
  });

  it("flags rows that share a shortcut in an overlapping context", () => {
    const rows = buildKeybindingRows([
      { command: "terminal.toggle", shortcut: shortcut({ key: "j" }) },
      { command: "preview.toggle", shortcut: shortcut({ key: "j", shiftKey: true }) },
      { command: "chat.find", shortcut: shortcut({ key: "j" }) },
    ]);
    const toggle = rows.find((row) => row.command === "terminal.toggle");
    expect(toggle?.conflicts).toContain("Chat: Find");
    expect(rows.find((row) => row.command === "preview.toggle")?.conflicts).toEqual([]);
  });

  it("does not flag rows whose when clauses are mutually exclusive", () => {
    const rows = buildKeybindingRows([
      {
        command: "terminal.split",
        shortcut: shortcut({ key: "d" }),
        whenAst: { type: "identifier", name: "terminalFocus" },
      },
      {
        command: "diff.toggle",
        shortcut: shortcut({ key: "d" }),
        whenAst: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    ]);
    expect(rows.every((row) => row.conflicts.length === 0)).toBe(true);
  });
});

describe("filterKeybindingRows", () => {
  const rows = buildKeybindingRows([
    { command: "terminal.toggle", shortcut: shortcut({ key: "j" }) },
    { command: "chat.find", shortcut: shortcut({ key: "f" }) },
  ]);

  it("returns everything on an empty query", () => {
    expect(filterKeybindingRows(rows, "   ")).toHaveLength(2);
  });

  it("matches labels, commands, keys, and when clauses", () => {
    expect(filterKeybindingRows(rows, "terminal")).toHaveLength(1);
    expect(filterKeybindingRows(rows, "chat.find")).toHaveLength(1);
    expect(filterKeybindingRows(rows, "mod+f")).toHaveLength(1);
    expect(filterKeybindingRows(rows, "nothing")).toHaveLength(0);
  });
});
