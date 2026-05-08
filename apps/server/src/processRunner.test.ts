import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Sink, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  isWindowsCommandNotFound,
  ProcessOutputLimitError,
  ProcessTimeoutError,
  runProcess,
} from "./processRunner.ts";

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

  it("supports the new Effect-native API", async () => {
    const result = await Effect.runPromise(
      runProcess({
        command: "node",
        args: [helperScriptPath, "stdout-bytes", "32"],
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("x".repeat(32));
    expect(result.timedOut).toBe(false);
  });

  it("supports an injected ChildProcessSpawner service", async () => {
    const fakeSpawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };

      expect(childProcess.command).toBe("fake");
      expect(childProcess.args).toEqual(["--ok"]);

      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode("ok")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

    const result = await Effect.runPromise(
      runProcess({
        command: "fake",
        args: ["--ok"],
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner)),
    );

    expect(result.stdout).toBe("ok");
    expect(result.code).toBe(0);
  });

  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      Effect.runPromise(
        runProcess({
          command: "node",
          args: [helperScriptPath, "stdout-bytes", "2048"],
          maxOutputBytes: 128,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toBeInstanceOf(ProcessOutputLimitError);
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await Effect.runPromise(
      runProcess({
        command: "node",
        args: [helperScriptPath, "stdout-bytes", "2048"],
        maxOutputBytes: 128,
        outputMode: "truncate",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("writes stdin before waiting for exit", async () => {
    const result = await Effect.runPromise(
      runProcess({
        command: "node",
        args: [helperScriptPath, "stdin-echo"],
        stdin: "stdin payload",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.stdout).toBe("stdin payload");
  });

  it("returns output for non-zero exit codes", async () => {
    const result = await Effect.runPromise(
      runProcess({
        command: "node",
        args: [helperScriptPath, "stderr-exit", "boom", "2"],
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("fails on timeout", async () => {
    await expect(
      Effect.runPromise(
        runProcess({
          command: "node",
          args: [helperScriptPath, "sleep", "500"],
          timeoutMs: 50,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });

  it("returns a synthetic timed out result when timeoutBehavior is timedOutResult", async () => {
    const result = await Effect.runPromise(
      runProcess({
        command: "node",
        args: [helperScriptPath, "sleep", "500"],
        timeoutMs: 50,
        timeoutBehavior: "timedOutResult",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result).toMatchObject({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
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
