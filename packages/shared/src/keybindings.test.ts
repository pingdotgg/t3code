import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("default keybindings", () => {
  it("archives the current thread with mod+shift+a outside terminal focus", () => {
    expect(
      DEFAULT_KEYBINDINGS.find((binding) => binding.command === "thread.archiveCurrent"),
    ).toEqual({
      key: "mod+shift+a",
      command: "thread.archiveCurrent",
      when: "!terminalFocus",
    });
  });
});
