import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  isRichTextBoldShortcut,
  isThreadNavigationShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
  shouldShowThreadJumpHintsForModifiers,
  shortcutLabelForCommand,
  terminalNavigationShortcutData,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("terminal word navigation", () => {
  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+Arrow to the terminal encoder on %s",
    (platform) => {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        assert.equal(terminalNavigationShortcutData(event({ key, ctrlKey: true }), platform), null);
      }
    },
  );

  it.each(["Win32", "Linux x86_64", "MacIntel"])(
    "preserves Alt+Arrow word navigation on %s",
    (platform) => {
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), platform),
        "\u001bb",
      );
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), platform),
        "\u001bf",
      );
    },
  );
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "rightPanel.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("previewFocus")),
    ),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);

describe("effectiveShortcutsForCommand", () => {
  it("passes only effective preview shortcuts to the desktop bridge", () => {
    const reopen = modShortcut("t", { shiftKey: true });
    const second = modShortcut("y", { shiftKey: true });
    const keybindings = compile([
      { shortcut: reopen, command: "view.reopenClosed" },
      {
        shortcut: second,
        command: "view.reopenClosed",
        whenAst: whenIdentifier("previewFocus"),
      },
      {
        shortcut: reopen,
        command: "preview.toggle",
        whenAst: whenIdentifier("previewFocus"),
      },
    ]);
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: true, previewOpen: true },
      }),
      [second],
    );
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: false },
      }),
      [reopen],
    );
  });
});

describe("settle thread shortcut", () => {
  it("does not intercept the terminal", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread undo shortcut", () => {
  it("leaves native undo alone inside text fields and terminals", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { editableFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("never shows jump hints while the terminal is focused, even with an unrestricted binding", () => {
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps default thread jumps off the web so the browser can switch tabs", () => {
    const input = event({ key: "1", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: false },
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true },
        },
      ),
    );
  });
});

describe("isThreadNavigationShortcut", () => {
  it("leaves a key to a focused terminal when the user's binding excludes it", () => {
    const next = event({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true });
    const terminal = { platform: "Linux x86_64", context: { terminalFocus: true } };
    assert.isTrue(isThreadNavigationShortcut(next, DEFAULT_RESOLVED_KEYBINDINGS, terminal));
    assert.isFalse(
      isThreadNavigationShortcut(
        next,
        mergeWithDefaultKeybindings(
          compileResolvedKeybindingsConfig([
            { key: "mod+shift+]", command: "thread.next", when: "!terminalFocus" },
          ]),
        ),
        terminal,
      ),
    );
    assert.isFalse(
      isThreadNavigationShortcut(
        event({ key: "o", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        terminal,
      ),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("keeps default model jumps off the web even while the picker is open", () => {
    const input = event({ key: "3", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false, modelPickerOpen: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: true },
      }),
      "modelPicker.jump.3",
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: false },
      }),
      "thread.jump.3",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("toggles the thread panel by default without taking terminal keystrokes", () => {
    for (const platform of ["MacIntel", "Win32", "Linux"]) {
      const input = event({
        key: "b",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: true,
      });
      assert.strictEqual(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: false, editableFocus: true },
        }),
        "threadPanel.toggle",
      );
      assert.isNull(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
      );
    }
  });

  it("preserves a user-configured thread panel shortcut instead of its default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compile([
        {
          shortcut: modShortcut("b", { altKey: true, shiftKey: true }),
          command: "threadPanel.toggle",
        },
      ]),
    );

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", metaKey: true, altKey: true, shiftKey: true }),
        bindings,
        { platform: "MacIntel" },
      ),
      "threadPanel.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "b", metaKey: true, shiftKey: true }), bindings, {
        platform: "MacIntel",
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});

describe("resolveChatShortcutCommand", () => {
  it("runs the active environment's script shortcut instead of the primary environment's", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it("does not run primary scripts before the active environment's bindings arrive", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, [], {
        platform: "Linux",
      }),
    );
  });

  it("keeps primary app commands ahead of conflicting active script shortcuts", () => {
    const primary = compile([{ shortcut: modShortcut("k"), command: "commandPalette.toggle" }]);
    const active = compile([{ shortcut: modShortcut("k"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "k", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "commandPalette.toggle",
    );
  });

  it("keeps app shortcuts on the primary environment when the active environment remaps them", () => {
    const primary = compile([{ shortcut: modShortcut("j"), command: "terminal.toggle" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "terminal.toggle" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "j", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it.each([false, true])(
    "preserves active binding precedence with terminalFocus=%s",
    (terminalFocus) => {
      const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
      const active = compile([
        { shortcut: modShortcut("r"), command: "script.deploy.run" },
        {
          shortcut: modShortcut("r"),
          command: "terminal.new",
          whenAst: whenIdentifier("terminalFocus"),
        },
      ]);
      const options = { platform: "Linux", context: { terminalFocus } };
      const shortcut = event({ key: "r", ctrlKey: true });

      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, primary, active, options),
        terminalFocus ? null : "script.deploy.run",
      );
      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, active, active, options),
        resolveShortcutCommand(shortcut, active, options),
      );
    },
  );
});

describe("resolveShortcutCommand", () => {
  it("routes mod+w to the terminal while focused and to the right panel otherwise", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "rightPanel.close",
    );
  });

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "rightPanel.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});

describe("isRichTextBoldShortcut", () => {
  const selected = { isCollapsed: false };

  it("matches the B key on non-Latin layouts, like the sidebar toggle does", () => {
    const cyrillicB = event({ key: "и", code: "KeyB", ctrlKey: true });
    assert.isTrue(isRichTextBoldShortcut(cyrillicB, selected));
    assert.strictEqual(
      resolveShortcutCommand(cyrillicB, DEFAULT_BINDINGS, { platform: "Win32" }),
      "sidebar.toggle",
    );
  });

  it("follows the letter a Latin layout types, not the physical key", () => {
    assert.isFalse(
      isRichTextBoldShortcut(event({ key: "x", code: "KeyB", ctrlKey: true }), selected),
    );
    assert.isTrue(
      isRichTextBoldShortcut(event({ key: "b", code: "KeyN", ctrlKey: true }), selected),
    );
  });

  it("leaves the chord to the sidebar toggle when no text is selected", () => {
    const modB = event({ key: "b", metaKey: true });
    assert.isFalse(isRichTextBoldShortcut(modB, { isCollapsed: true }));
    assert.isFalse(isRichTextBoldShortcut(modB, null));
  });
});

describe("composer and pull request shortcuts", () => {
  it("fills missing number shortcuts without replacing the saved URL binding", () => {
    const olderServerBindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "pullRequest.copyNumber" && binding.command !== "thread.copyReference",
    );
    const bindings = mergeWithDefaultKeybindings([
      ...olderServerBindings,
      ...compileResolvedKeybindingsConfig([
        { key: "mod+shift+8", command: "thread.copyReference", when: "!terminalFocus" },
      ]),
    ]);
    for (const [key, command] of [
      ["k", "pullRequest.copyNumber"],
      ["8", "thread.copyReference"],
      ["c", null],
      ["y", null],
    ] as const) {
      assert.strictEqual(
        resolveShortcutCommand(event({ key, metaKey: true, shiftKey: true }), bindings, {
          platform: "MacIntel",
        }),
        command,
      );
    }
  });

  it.each(["MacIntel", "Win32", "Linux"])(
    "reserves the alternate send chord for the focused composer on %s",
    (platform) => {
      const modifier = {
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const shiftedEnter = event({ key: "Enter", shiftKey: true, ...modifier });
      for (const composerRequiresModifier of [false, true]) {
        const context = {
          composerFocus: true,
          turnRunning: true,
          composerRequiresModifier,
        };
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          }),
          composerRequiresModifier ? "composer.sendAlternate" : "thread.steerQueuedMessage",
        );
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "composer.sendAlternate", {
            platform,
            context,
          }),
          formatShortcutLabel(
            modShortcut("enter", { shiftKey: composerRequiresModifier }),
            platform,
          ),
        );
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context: { ...context, composerFocus: false },
          }),
          "thread.steerQueuedMessage",
        );
      }
    },
  );

  const altEffortBindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+e", command: "composer.effort", when: "!terminalFocus" },
  ]);

  it("leaves AltGr text entry alone with a custom Alt binding", () => {
    for (const platform of ["Win32", "Linux"]) {
      const input = event({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      });
      assert.isNull(resolveShortcutCommand(input, altEffortBindings, { platform }));
      assert.strictEqual(
        resolveShortcutCommand({ ...input, getModifierState: () => false }, altEffortBindings, {
          platform,
        }),
        "composer.effort",
      );
    }
  });

  it("keeps Firefox modifier reporting usable on Windows and macOS", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "e", ctrlKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "Win32" },
      ),
      "composer.effort",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "´", code: "KeyE", metaKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "MacIntel" },
      ),
      "composer.effort",
    );
  });
});

describe("Usage shortcuts", () => {
  it.each(["Linux", "MacIntel"])(
    "preserves desktop numbered thread shortcuts on Usage on %s",
    (platform) => {
      const shortcut = event({
        key: "2",
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
      });
      assert.strictEqual(
        resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
        "thread.jump.2",
      );
      assert.isNotNull(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.2", {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
      );
    },
  );

  it("matches shifted number keys for periods and only on Usage", () => {
    const shortcut = event({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.period.day",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });
});
