import { expect, it } from "vite-plus/test";

import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT } from "./terminalOutput.ts";

it.each(["]", "P", "X", "_", "^"])("keeps output after a cancelled ESC %s string", (introducer) => {
  for (const cancel of ["\u0018", "\u001a"]) {
    const input = `before\u001b${introducer}payload${cancel}Ready`;
    for (let cut = 0; cut <= input.length; cut += 1) {
      const first = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, input.slice(0, cut));
      const output = appendTerminalOutput(first, input.slice(cut));
      expect(output.text).toBe("beforeReady");
    }
  }
});
