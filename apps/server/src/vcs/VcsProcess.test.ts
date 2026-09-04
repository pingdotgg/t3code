import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

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
  it.effect("bounds a synthetic burst of GitHub API processes", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const starts = yield* Queue.unbounded<number>();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const total = yield* Ref.make(0);
      const service = yield* VcsProcess.make.pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(active, (held) => held + 1);
                yield* Ref.update(peak, (held) => Math.max(held, count));
                yield* Ref.update(total, (held) => held + 1);
                yield* Queue.offer(starts, count);
                yield* Deferred.await(gate);
                return {
                  stdout: "",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }).pipe(Effect.ensuring(Ref.update(active, (count) => count - 1))),
          }),
        ),
      );

      const burst = yield* Effect.all(
        Array.from({ length: 32 }, (_, index) =>
          service.run({
            operation: `synthetic.github.${index}`,
            command: "gh",
            args: ["api", "user"],
            cwd: "/workspace",
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(starts)));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(starts)).toBe(0);
      expect(yield* Ref.get(peak)).toBe(4);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(burst);
      expect(yield* Ref.get(total)).toBe(32);
      expect(yield* Ref.get(peak)).toBe(4);
    }),
  );

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
        stderrLength: secretStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(secretArgument);
      expect(error.message).not.toContain(secretStderr);
    }).pipe(provideLive),
  );

  it.effect("classifies authentication failures without retaining stderr", () =>
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
        stderrLength: secretStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(secretStderr);
      expect(error.message).not.toContain("super-secret-token");
    }).pipe(provideLive),
  );

  it.effect("classifies API rate limits without retaining provider stderr", () =>
    Effect.gen(function* () {
      const providerStderr =
        "GraphQL: API rate limit already exceeded for user ID 51714798 and token secret-value.";
      const error = yield* run({
        operation: "test.rate-limit",
        command: "node",
        args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", providerStderr],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        command: "node",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
        stderrLength: providerStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(providerStderr);
      expect(error.message).not.toContain("secret-value");
    }).pipe(provideLive),
  );

  it.effect("classifies HTTP 429 responses as rate limits", () =>
    Effect.gen(function* () {
      const providerStderr = "HTTP 429: Too Many Requests. request-id=secret-value";
      const error = yield* run({
        operation: "test.rate-limit",
        command: "node",
        args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", providerStderr],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      expect(error.message).not.toContain(providerStderr);
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
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
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

  it.effect("fails with measured byte counts when output must not be truncated", () =>
    Effect.gen(function* () {
      const error = yield* run({
        operation: "test.output-limit",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: yield* HostProcessWorkingDirectory,
        maxOutputBytes: 128,
        outputMode: "error",
      }).pipe(Effect.flip);

      assert(error._tag === "VcsProcessOutputLimitError");
      expect(error.stream).toBe("stdout");
      expect(error.maxBytes).toBe(128);
      expect(error.observedBytes).toBeGreaterThan(error.maxBytes);
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
