import { describe, expect, it } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("preserves argument boundaries for shell-sensitive values", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "Add GHCR Docker publish workflow",
      "ampersand & value",
      'quoted " value',
    ]);

    expect(JSON.parse(result.stdout)).toEqual([
      "Add GHCR Docker publish workflow",
      "ampersand & value",
      'quoted " value',
    ]);
  });

  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });
});
