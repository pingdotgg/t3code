// @effect-diagnostics nodeBuiltinImport:off - exercises the Node process/file boundary used by the capture helper.
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { captureOpenCodeCommandWithFileStdout } from "./opencodeRuntime.ts";

describe("captureOpenCodeCommandWithFileStdout", () => {
  it("captures stdout larger than a pipe buffer without dropping the tail", async () => {
    const size = 512 * 1024;
    const marker = "PRO_MAX_AT_THE_END";
    const result = await captureOpenCodeCommandWithFileStdout({
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${size}) + "${marker}")`],
      platform: "darwin",
      shell: false,
    });

    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(result.stdout.length, size + marker.length);
    NodeAssert.ok(result.stdout.endsWith(marker));
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await captureOpenCodeCommandWithFileStdout({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("failed"); process.exit(7)'],
      platform: "darwin",
      shell: false,
    });

    NodeAssert.equal(result.code, 7);
    NodeAssert.equal(result.stdout, "");
    NodeAssert.equal(result.stderr, "failed");
  });

  it("aborts a running command", async () => {
    const controller = new AbortController();
    const result = captureOpenCodeCommandWithFileStdout({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      platform: "darwin",
      shell: false,
      signal: controller.signal,
    });
    controller.abort();

    await NodeAssert.rejects(result, (cause: unknown) => {
      return cause instanceof Error && cause.name === "AbortError";
    });
  });
});
