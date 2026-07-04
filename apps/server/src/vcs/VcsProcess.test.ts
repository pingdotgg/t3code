import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import {
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";

const run = (input: VcsProcess.VcsProcessInput) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return yield* process.run(input);
  });

const liveLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R | VcsProcess.VcsProcess>) =>
  effect.pipe(Effect.provide(liveLayer));

const baseInput = {
  operation: "test.process-boundary",
  command: "git",
  args: ["status", "--short"],
  cwd: "/workspace",
} satisfies VcsProcess.VcsProcessInput;

const captureProcessResult = (
  result: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  VcsProcess.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => result }),
    ),
    Effect.flatMap((service) => service.run(baseInput)),
    Effect.flip,
  );

describe("VcsProcess.run", () => {
  it.effect("collects stdout", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.stdout",
        command: "node",
        args: ["-e", "process.stdout.write('hello')"],
        cwd: process.cwd(),
      });

      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("");
      expect(result.stdoutTruncated).toBe(false);
      expect(result.stderrTruncated).toBe(false);
    }).pipe(provideLive),
  );

  it.effect("writes stdin before waiting for exit", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.stdin",
        command: "node",
        args: [
          "-e",
          [
            "process.stdin.setEncoding('utf8');",
            "let data='';",
            "process.stdin.on('data', chunk => { data += chunk; });",
            "process.stdin.on('end', () => { process.stdout.write(data); });",
          ].join(""),
        ],
        cwd: process.cwd(),
        stdin: "stdin payload",
      });

      expect(result.stdout).toBe("stdin payload");
    }).pipe(provideLive),
  );

  it.effect("fails with VcsProcessExitError for non-zero exits by default", () =>
    Effect.gen(function* () {
      const secretArgument = "--token=super-secret-token";
      const secretStderr = "remote rejected super-secret-token";
      const error = yield* run({
        operation: "test.exit",
        command: "node",
        args: [
          "-e",
          "process.stderr.write(process.argv[1]); process.exit(2)",
          secretStderr,
          secretArgument,
        ],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        operation: "test.exit",
        command: "node",
        argumentCount: 4,
        exitCode: 2,
        detail: "Process exited with a non-zero status.",
        failureKind: "command-failed",
        stderr: secretStderr,
        stderrLength: secretStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(secretArgument);
      expect(error.message).not.toContain(secretStderr);
    }).pipe(provideLive),
  );

  it.effect("classifies authentication failures with capped stderr off the message", () =>
    Effect.gen(function* () {
      const secretStderr = "authentication failed for token super-secret-token";
      const error = yield* run({
        operation: "test.authentication",
        command: "node",
        args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", secretStderr],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        operation: "test.authentication",
        command: "node",
        exitCode: 1,
        detail: "Authentication failed.",
        failureKind: "authentication",
        stderr: secretStderr,
        stderrLength: secretStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(secretStderr);
      expect(error.message).not.toContain("super-secret-token");
    }).pipe(provideLive),
  );

  it.effect("retains spawn causes without exposing process arguments in the error message", () =>
    Effect.gen(function* () {
      const secretArgument = "--token=super-secret-token";
      const error = yield* run({
        operation: "test.spawn",
        command: "definitely-not-a-t3code-executable",
        args: [secretArgument],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessSpawnError);
      expect(error).toMatchObject({
        operation: "test.spawn",
        command: "definitely-not-a-t3code-executable",
        argumentCount: 1,
      });
      expect(error).toHaveProperty("cause");
      expect(error.message).not.toContain(secretArgument);
    }).pipe(provideLive),
  );

  it.effect("preserves real boundary causes without manufacturing structural ones", () =>
    Effect.gen(function* () {
      const cause = new Error("secret stdin failure");
      const error = yield* captureProcessResult(
        Effect.fail(
          new ProcessRunner.ProcessStdinError({
            command: baseInput.command,
            argumentCount: baseInput.args.length,
            cwd: baseInput.cwd,
            stdinBytes: 47,
            cause,
          }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "VcsProcessStdinWriteError",
        operation: baseInput.operation,
        stdinBytes: 47,
        cause,
      });
      expect(error.message).not.toContain(cause.message);

      const missingExitCodeError = yield* captureProcessResult(
        Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      expect(missingExitCodeError).toMatchObject({
        _tag: "VcsProcessMissingExitCodeError",
        operation: baseInput.operation,
        command: baseInput.command,
        cwd: baseInput.cwd,
        argumentCount: baseInput.args.length,
      });
      expect(missingExitCodeError).not.toHaveProperty("cause");
    }),
  );

  it.effect("returns output when non-zero exits are allowed", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.allowed-exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
        allowNonZeroExit: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("boom");
    }).pipe(provideLive),
  );

  it.effect("truncates output and appends the marker when requested", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-marker",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
        appendTruncationMarker: true,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[truncated]");
      expect(result.stderrTruncated).toBe(false);
    }).pipe(provideLive),
  );

  it.effect("truncates without the marker when truncation markers are disabled", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-silent",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).not.toContain("[truncated]");
    }).pipe(provideLive),
  );

  it.effect("fails with VcsProcessTimeoutError on timeout", () =>
    Effect.gen(function* () {
      const errorFiber = yield* run({
        operation: "test.timeout",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: process.cwd(),
        timeoutMs: 50,
      }).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toBeInstanceOf(VcsProcessTimeoutError);
    }).pipe(provideLive),
  );
});
