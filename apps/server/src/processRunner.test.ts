import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isWindowsCommandNotFound, runProcess } from "./processRunner.ts";

function makeHelperScript(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "t3-process-runner-test-"));
  const helperPath = path.join(directory, "helper.js");
  writeFileSync(
    helperPath,
    [
      "const mode = process.argv[2];",
      "if (mode === 'stdout-bytes') {",
      "  process.stdout.write('x'.repeat(Number(process.argv[3] ?? '0')));",
      "} else if (mode === 'stdin-echo') {",
      "  process.stdin.setEncoding('utf8');",
      "  let data = '';",
      "  process.stdin.on('data', (chunk) => { data += chunk; });",
      "  process.stdin.on('end', () => { process.stdout.write(data); });",
      "} else if (mode === 'stderr-exit') {",
      "  process.stderr.write(process.argv[3] ?? '');",
      "  process.exit(Number(process.argv[4] ?? '0'));",
      "} else if (mode === 'sleep') {",
      "  setTimeout(() => process.stdout.write('late'), Number(process.argv[3] ?? '0'));",
      "} else {",
      "  process.exit(2);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return helperPath;
}

function cleanupHelperScript(helperPath: string) {
  rmSync(path.dirname(helperPath), { recursive: true, force: true });
}

describe("runProcess", () => {
  const helperScriptPath = makeHelperScript();

  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", [helperScriptPath, "stdout-bytes", "2048"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", [helperScriptPath, "stdout-bytes", "2048"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("writes stdin before waiting for exit", async () => {
    const result = await runProcess("node", [helperScriptPath, "stdin-echo"], {
      stdin: "stdin payload",
    });

    expect(result.stdout).toBe("stdin payload");
  });

  it("returns output when non-zero exits are allowed", async () => {
    const result = await runProcess("node", [helperScriptPath, "stderr-exit", "boom", "2"], {
      allowNonZeroExit: true,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("fails on timeout", async () => {
    await expect(
      runProcess("node", [helperScriptPath, "sleep", "500"], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out");
  });

  it("returns a timed out result when non-zero exits are allowed", async () => {
    const result = await runProcess("node", [helperScriptPath, "sleep", "500"], {
      timeoutMs: 50,
      allowNonZeroExit: true,
    });

    expect(result.timedOut).toBe(true);
  });

  afterAll(() => {
    cleanupHelperScript(helperScriptPath);
  });
});

describe("isWindowsCommandNotFound", () => {
  it("matches the localized German cmd.exe error text", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      expect(
        isWindowsCommandNotFound(
          1,
          "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
        ),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
