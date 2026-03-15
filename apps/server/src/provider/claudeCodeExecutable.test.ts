import { describe, expect, it } from "vitest";

import { resolveClaudeCodeExecutablePath, toAsarUnpackedPath } from "./claudeCodeExecutable";

describe("toAsarUnpackedPath", () => {
  it("rewrites darwin asar paths to the unpacked directory", () => {
    expect(
      toAsarUnpackedPath(
        "/Applications/T3 Code.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
      ),
    ).toBe(
      "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
    );
  });

  it("rewrites win32 asar paths to the unpacked directory", () => {
    expect(
      toAsarUnpackedPath(
        String.raw`C:\Users\me\AppData\Local\Programs\T3 Code\resources\app.asar\node_modules\@anthropic-ai\claude-agent-sdk\cli.js`,
      ),
    ).toBe(
      String.raw`C:\Users\me\AppData\Local\Programs\T3 Code\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk\cli.js`,
    );
  });
});

describe("resolveClaudeCodeExecutablePath", () => {
  it("prefers the unpacked Electron path when it exists", () => {
    const packagedPath =
      "/Applications/T3 Code.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
    const unpackedCliPath =
      "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js";

    expect(
      resolveClaudeCodeExecutablePath({
        resolvePackageEntry: () => packagedPath,
        exists: (path) => path === unpackedCliPath,
      }),
    ).toBe(unpackedCliPath);
  });

  it("falls back to the packaged cli when no unpacked path exists", () => {
    const packagedPath = "/Users/me/dev/t3/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
    const packagedCliPath = "/Users/me/dev/t3/node_modules/@anthropic-ai/claude-agent-sdk/cli.js";

    expect(
      resolveClaudeCodeExecutablePath({
        resolvePackageEntry: () => packagedPath,
        exists: (path) => path === packagedCliPath,
      }),
    ).toBe(packagedCliPath);
  });

  it("returns undefined when the sdk package cannot be resolved", () => {
    expect(
      resolveClaudeCodeExecutablePath({
        resolvePackageEntry: () => {
          throw new Error("missing");
        },
      }),
    ).toBeUndefined();
  });
});
