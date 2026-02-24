import { Schema } from "effect";
import { assert, describe, it } from "vitest";

import {
  KeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings";

const decode = <S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> =>
  Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;

const decodeResolvedRuleStrict = (input: unknown) =>
  Schema.decodeUnknownSync(ResolvedKeybindingRule as never)(input, {
    onExcessProperty: "error",
  });

describe("keybindings contracts", () => {
  it("parses keybinding rules", () => {
    const parsed = decode(KeybindingRule, {
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedLocal = decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");
  });

  it("rejects invalid command values", () => {
    assert.throws(() =>
      decode(KeybindingRule, {
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
  });

  it("accepts dynamic script run commands", () => {
    const parsed = decode(KeybindingRule, {
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  });

  it("parses keybindings array payload", () => {
    const parsed = decode(KeybindingsConfig, [
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  });

  it("parses resolved keybinding rules", () => {
    const parsed = decode(ResolvedKeybindingRule, {
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
    const parsed = decode(ResolvedKeybindingsConfig, [
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
      decodeResolvedRuleStrict({
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
