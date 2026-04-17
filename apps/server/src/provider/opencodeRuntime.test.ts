import assert from "node:assert/strict";

import { describe, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn((command: string, args: ReadonlyArray<string>) => {
    if (command === "which" && args[0] === "opencode") {
      return "/opt/homebrew/bin/opencode\n";
    }
    return "";
  }),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);

describe("resolveOpenCodeBinaryPath", () => {
  it("returns absolute binary paths without PATH lookup", async () => {
    const { resolveOpenCodeBinaryPath } = await import("./opencodeRuntime.ts");

    assert.equal(resolveOpenCodeBinaryPath("/usr/local/bin/opencode"), "/usr/local/bin/opencode");
    assert.equal(childProcessMock.execFileSync.mock.calls.length, 0);
  });

  it("resolves command names through PATH", async () => {
    const { resolveOpenCodeBinaryPath } = await import("./opencodeRuntime.ts");

    assert.equal(resolveOpenCodeBinaryPath("opencode"), "/opt/homebrew/bin/opencode");
    assert.deepEqual(childProcessMock.execFileSync.mock.calls[0], [
      "which",
      ["opencode"],
      {
        encoding: "utf8",
        timeout: 3_000,
      },
    ]);
  });
});
