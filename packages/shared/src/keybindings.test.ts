import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindings.ts";

describe("DEFAULT_KEYBINDINGS", () => {
  it("binds mod+alt+j to rightPanel.openTerminal", () => {
    const rules = DEFAULT_KEYBINDINGS.filter((rule) => rule.command === "rightPanel.openTerminal");
    expect(rules).toEqual([{ key: "mod+alt+j", command: "rightPanel.openTerminal" }]);
  });

  it("resolves the rightPanel.openTerminal default binding", () => {
    const binding = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (rule) => rule.command === "rightPanel.openTerminal",
    );
    expect(binding?.shortcut).toEqual({
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: true,
    });
  });
});
