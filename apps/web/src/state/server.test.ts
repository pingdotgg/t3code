import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ResolvedKeybindingRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { resolvePrimaryServerKeybindings } from "./server";

describe("primary server keybindings", () => {
  it("keeps the default Board shortcut for older servers without permitting writes", () => {
    const legacyKeybindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (keybinding) => keybinding.command !== "board.open",
    );
    const effectiveKeybindings = resolvePrimaryServerKeybindings(legacyKeybindings, false);

    expect(
      resolveShortcutCommand(
        {
          key: "b",
          metaKey: false,
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        },
        effectiveKeybindings,
        { platform: "Linux", context: { terminalFocus: false } },
      ),
    ).toBe("board.open");
  });

  it("preserves a removed Board shortcut when the server advertises support", () => {
    const keybindingsWithoutBoard = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (keybinding) => keybinding.command !== "board.open",
    );

    expect(resolvePrimaryServerKeybindings(keybindingsWithoutBoard, true)).toBe(
      keybindingsWithoutBoard,
    );
  });

  it("lets a persisted legacy shortcut win over the Board fallback", () => {
    const boardBinding = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (keybinding) => keybinding.command === "board.open",
    );
    if (!boardBinding) throw new Error("Expected a default Board shortcut.");
    const overridingBinding = {
      command: "rightPanel.toggleMaximized",
      shortcut: boardBinding.shortcut,
      ...(boardBinding.whenAst ? { whenAst: boardBinding.whenAst } : {}),
    } satisfies ResolvedKeybindingRule;
    const legacyKeybindings = [
      ...DEFAULT_RESOLVED_KEYBINDINGS.filter((keybinding) => keybinding.command !== "board.open"),
      overridingBinding,
    ];

    expect(
      resolveShortcutCommand(
        {
          key: "b",
          metaKey: false,
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        },
        resolvePrimaryServerKeybindings(legacyKeybindings, false),
        { platform: "Linux", context: { terminalFocus: false } },
      ),
    ).toBe("rightPanel.toggleMaximized");
  });
});
