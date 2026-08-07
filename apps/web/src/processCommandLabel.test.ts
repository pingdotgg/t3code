import { describe, expect, it } from "vite-plus/test";

import { formatProcessCommand } from "./processCommandLabel";

describe("formatProcessCommand", () => {
  it("shrinks absolute interpreter paths to their basename", () => {
    expect(
      formatProcessCommand({
        commandLine:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\pnpm\\bin\\pnpm.cjs" build',
        processName: "node.exe",
      }),
    ).toBe("node pnpm.cjs build");
  });

  it("strips cmd shell wrapper prefixes", () => {
    expect(
      formatProcessCommand({
        commandLine: 'cmd /d /s /c ""C:\\repo\\node_modules\\.bin\\pnpm.CMD" build"',
        processName: "cmd.exe",
      }),
    ).toBe("pnpm.CMD build");
  });

  it("handles posix command lines", () => {
    expect(
      formatProcessCommand({
        commandLine: "/usr/local/bin/node /repo/node_modules/.bin/vite dev",
        processName: "node",
      }),
    ).toBe("node vite dev");
  });

  it("falls back to the process name without a command line", () => {
    expect(formatProcessCommand({ commandLine: null, processName: "esbuild.exe" })).toBe(
      "esbuild.exe",
    );
    expect(formatProcessCommand({ commandLine: "   ", processName: null })).toBe("Process");
  });
});
