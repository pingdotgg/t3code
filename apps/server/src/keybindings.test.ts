import { assert, describe, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingRule,
  parseKeybindingShortcut,
} from "./keybindings";

describe("server keybindings", () => {
  it("parses shortcuts including plus key", () => {
    assert.deepEqual(parseKeybindingShortcut("mod+j"), {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
    assert.deepEqual(parseKeybindingShortcut("mod++"), {
      key: "+",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });

  it("compiles valid rule with parsed when AST", () => {
    const compiled = compileResolvedKeybindingRule({
      key: "mod+d",
      command: "terminal.split",
      when: "terminalOpen && !terminalFocus",
    });

    assert.deepEqual(compiled, {
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
  });

  it("rejects invalid rules", () => {
    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+shift+d+o",
        command: "terminal.new",
      }),
    );

    assert.isNull(
      compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalFocus && (",
      }),
    );
  });

  it("defines defaults for terminal.close and chat.newSameGitState", () => {
    assert.deepInclude(DEFAULT_KEYBINDINGS, {
      key: "mod+w",
      command: "terminal.close",
      when: "terminalFocus",
    });
    assert.deepInclude(DEFAULT_KEYBINDINGS, {
      key: "mod+shift+n",
      command: "chat.newSameGitState",
    });
  });
});
