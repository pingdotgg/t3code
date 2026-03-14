import { assert, beforeEach, describe, it, vi } from "vitest";

import type { ProcessRunOptions, ProcessRunResult } from "./processRunner";

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options?: ProcessRunOptions,
      ) => Promise<ProcessRunResult>
    >(),
}));

vi.mock("./processRunner", () => ({
  runProcess: runProcessMock,
}));

function processResult(
  overrides: Partial<ProcessRunResult> & Pick<ProcessRunResult, "stdout" | "code">,
): ProcessRunResult {
  return {
    stdout: overrides.stdout,
    code: overrides.code,
    stderr: overrides.stderr ?? "",
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    stdoutTruncated: overrides.stdoutTruncated ?? false,
    stderrTruncated: overrides.stderrTruncated ?? false,
  };
}

describe("gitIgnore", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
    vi.resetModules();
  });

  it("chunks large git check-ignore requests and filters ignored matches", async () => {
    const ignoredPaths = Array.from(
      { length: 320 },
      (_, index) => `ignored/${index.toString().padStart(4, "0")}/${"x".repeat(1024)}.ts`,
    );
    const keptPaths = ["src/keep.ts", "docs/readme.md"];
    const relativePaths = [...ignoredPaths, ...keptPaths];
    let checkIgnoreCalls = 0;

    runProcessMock.mockImplementation(async (_command, args, options) => {
      if (args[0] === "check-ignore") {
        checkIgnoreCalls += 1;
        const chunkPaths = (options?.stdin ?? "").split("\0").filter((value) => value.length > 0);
        const chunkIgnored = chunkPaths.filter((value) => value.startsWith("ignored/"));
        return processResult({
          code: chunkIgnored.length > 0 ? 0 : 1,
          stdout: chunkIgnored.length > 0 ? `${chunkIgnored.join("\0")}\0` : "",
        });
      }

      throw new Error(`Unexpected command: git ${args.join(" ")}`);
    });

    const { filterGitIgnoredPaths } = await import("./gitIgnore");
    const result = await filterGitIgnoredPaths("/virtual/workspace", relativePaths);

    assert.isAbove(checkIgnoreCalls, 1);
    assert.deepEqual(result, keptPaths);
  });

  it("fails open when git check-ignore cannot complete", async () => {
    const relativePaths = ["src/keep.ts", "ignored.txt"];

    runProcessMock.mockRejectedValueOnce(new Error("spawn failed"));

    const { filterGitIgnoredPaths } = await import("./gitIgnore");
    const result = await filterGitIgnoredPaths("/virtual/workspace", relativePaths);

    assert.deepEqual(result, relativePaths);
  });
});
