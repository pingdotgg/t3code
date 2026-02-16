import { assert, describe, it } from "vitest";

import {
  keybindingRuleSchema,
  keybindingsConfigSchema,
  resolvedKeybindingRuleSchema,
  resolvedKeybindingsConfigSchema,
} from "./keybindings";

describe("keybindings contracts", () => {
  it("parses keybinding rules", () => {
    const parsed = keybindingRuleSchema.parse({
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = keybindingRuleSchema.parse({
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedLocal = keybindingRuleSchema.parse({
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");
  });

  it("rejects invalid command values", () => {
    assert.throws(() =>
      keybindingRuleSchema.parse({
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
  });

  it("accepts dynamic script run commands", () => {
    const parsed = keybindingRuleSchema.parse({
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  });

  it("parses keybindings array payload", () => {
    const parsed = keybindingsConfigSchema.parse([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  });

  it("parses resolved keybinding rules", () => {
    const parsed = resolvedKeybindingRuleSchema.parse({
      command: "terminal.split",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "terminalOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    });
    assert.strictEqual(parsed.shortcut.key, "d");
  });

  it("parses resolved keybindings arrays", () => {
    const parsed = resolvedKeybindingsConfigSchema.parse([
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 1);
  });

  it("rejects unknown fields in resolved keybinding rules", () => {
    assert.throws(() =>
      resolvedKeybindingRuleSchema.parse({
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        key: "mod+j",
      }),
    );
  });
});
