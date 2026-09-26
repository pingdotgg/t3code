import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encodeExitError = Schema.encodeEffect(Schema.fromJsonString(VcsProcessExitError));

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
  input: VcsProcess.VcsProcessInput = baseInput,
) =>
  VcsProcess.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => result }),
    ),
    Effect.flatMap((service) => service.run(input)),
    Effect.flip,
  );

const failedExit = (stdout: string, stderr: string) =>
  Effect.succeed({
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(1),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

const ghApiInput = {
  operation: "test.gh-api",
  command: "gh",
  args: ["api", "--method", "POST", "repos/owner/repo/pulls/1/reviews", "--input", "-"],
  cwd: "/workspace",
} satisfies VcsProcess.VcsProcessInput;

describe("VcsProcess.run", () => {
  it.effect.each([
    { stderr: "fatal: Unable to create '/private/repo/index.lock': File exists", retryable: true },
    {
      stderr: "fatal: Unable to create '/private/repo/index.lock': Permission denied",
      retryable: false,
    },
    { stderr: 'error: open("/private/repo/file"): No such file or directory', retryable: true },
    {
      stderr: "fatal: unable to stat '/private/repo/file': No such file or directory",
      retryable: true,
    },
    { stderr: 'error: open("/private/repo/file"): Permission denied', retryable: false },
    {
      stderr: "error: '/private/repo/child/' does not have a commit checked out",
      retryable: false,
    },
    { stderr: "fatal: index file corrupt", retryable: false },
  ])(
    "classifies Git exit retryability without retaining stderr: $stderr",
    ({ stderr, retryable }) =>
      Effect.gen(function* () {
        const error = yield* captureProcessResult(
          Effect.succeed({
            stdout: "",
            stderr,
            code: ChildProcessSpawner.ExitCode(128),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        );
        assert.instanceOf(error, VcsProcessExitError);
        expect(error.retryable === true).toBe(retryable);
        const encoded = yield* encodeExitError(error);
        expect(encoded).not.toContain("/private/repo");
      }),
  );

  it.effect.each([
    {
      name: "string errors",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      body: JSON.stringify({
        message: "Unprocessable Entity",
        errors: ["Line could not be resolved"],
        status: "422",
      }),
      hostMessage: "Line could not be resolved",
    },
    {
      name: "error objects",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      body: JSON.stringify({
        message: "Validation Failed",
        errors: [
          { resource: "PullRequestReviewComment", code: "custom", message: "Path is missing" },
          { resource: "PullRequestReviewComment", code: "custom", message: "Body is too long" },
        ],
        status: "422",
      }),
      hostMessage: "Path is missing; Body is too long",
    },
  ])("keeps GitHub's own reason for refusing a gh api request: $name", ({ body, hostMessage }) =>
    Effect.gen(function* () {
      // gh prints only the generic top-level message on stderr; the reason is in the body.
      const error = yield* captureProcessResult(
        failedExit(body, "gh: Unprocessable Entity (HTTP 422)\n"),
        ghApiInput,
      );
      assert.instanceOf(error, VcsProcessExitError);
      expect(error.failureKind).toBe("command-failed");
      expect(error.hostMessage).toBe(hostMessage);
    }),
  );

  it.effect.each([
    { name: "a non-JSON body", command: "gh", stdout: "not json" },
    {
      name: "errors without a message",
      command: "gh",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      stdout: JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "Label", code: "missing_field", field: "name" }],
      }),
    },
    {
      name: "a command other than gh",
      command: "git",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      stdout: JSON.stringify({ errors: ["Line could not be resolved"] }),
    },
    {
      name: "a gh command other than api",
      command: "gh",
      args: ["pr", "view", "1", "--json", "number"],
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      stdout: JSON.stringify({ errors: ["Line could not be resolved"] }),
    },
  ])("keeps no host reason for $name", ({ command, args, stdout }) =>
    Effect.gen(function* () {
      const error = yield* captureProcessResult(failedExit(stdout, "failed\n"), {
        ...ghApiInput,
        command,
        ...(args === undefined ? {} : { args }),
      });
      assert.instanceOf(error, VcsProcessExitError);
      expect(error.hostMessage).toBeUndefined();
    }),
  );

  it.effect("bounds the host reason GitHub gives", () =>
    Effect.gen(function* () {
      const error = yield* captureProcessResult(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        failedExit(JSON.stringify({ errors: ["x".repeat(2_000)] }), "gh: HTTP 422\n"),
        ghApiInput,
      );
      assert.instanceOf(error, VcsProcessExitError);
      expect(error.hostMessage?.length).toBeLessThanOrEqual(300);
    }),
  );

  it.effect.each(["timeout", "spawn"] as const)(
    "checkpoint commands do not retry %s failures",
    (kind) =>
      Effect.gen(function* () {
        let attempts = 0;
        const fields = { command: "git", argumentCount: 2, cwd: "/workspace" };
        const failure =
          kind === "timeout"
            ? new ProcessRunner.ProcessTimeoutError({ ...fields, timeoutMs: 30_000 })
            : new ProcessRunner.ProcessSpawnError({ ...fields, cause: new Error("spawn failed") });
        const service = yield* VcsProcess.make.pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () =>
              Effect.sync(() => {
                attempts += 1;
              }).pipe(Effect.andThen(Effect.fail(failure))),
          }),
        );
        const error = yield* service
          .run({
            ...baseInput,
            operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
          })
          .pipe(Effect.flip);
        expect(attempts).toBe(1);
        expect(error._tag).toBe(
          kind === "timeout" ? "VcsProcessTimeoutError" : "VcsProcessSpawnError",
        );
      }),
  );

  it.effect.each([
    {
      name: "recovers after two lock failures",
      failures: 2,
      attempts: 3,
      transient: true,
      capture: true,
      streaming: false,
    },
    {
      name: "bounds persistent lock failures",
      failures: Infinity,
      attempts: 3,
      transient: true,
      capture: true,
      streaming: false,
    },
    {
      name: "does not retry unknown exits",
      failures: Infinity,
      attempts: 1,
      transient: false,
      capture: true,
      streaming: false,
    },
    {
      name: "leaves other operations unchanged",
      failures: Infinity,
      attempts: 1,
      transient: true,
      capture: false,
      streaming: false,
    },
    {
      name: "does not replay stdout callbacks",
      failures: Infinity,
      attempts: 1,
      transient: true,
      capture: true,
      streaming: true,
    },
  ])(
    "checkpoint command retry $name",
    ({ failures, attempts: expectedAttempts, transient, capture, streaming }) =>
      Effect.gen(function* () {
        let attempts = 0;
        const service = yield* VcsProcess.make.pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () =>
              Effect.sync(() => {
                attempts += 1;
                return {
                  stdout: "",
                  stderr:
                    attempts > failures
                      ? ""
                      : transient
                        ? "fatal: Unable to create '/repo/index.lock': File exists"
                        : "fatal: index file corrupt",
                  code: ChildProcessSpawner.ExitCode(attempts > failures ? 0 : attempts),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        );
        const fiber = yield* service
          .run({
            ...baseInput,
            operation: capture ? VcsProcess.CHECKPOINT_CAPTURE_OPERATION : baseInput.operation,
            ...(streaming ? { onStdoutChunk: () => {} } : {}),
          })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* TestClock.adjust("150 millis");
        const result = yield* Fiber.join(fiber);
        expect(attempts).toBe(expectedAttempts);
        if (failures === Infinity) {
          if (Exit.isSuccess(result))
            return yield* Effect.die("Expected a capture command failure");
          const error = Cause.findErrorOption(result.cause);
          if (error._tag === "None" || error.value._tag !== "VcsProcessExitError") {
            return yield* Effect.die("Expected a Git exit error");
          }
          expect(error.value.exitCode).toBe(expectedAttempts);
        } else {
          expect(Exit.isSuccess(result)).toBe(true);
        }
      }),
  );

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

  it.effect("streams all stdout bytes beyond the buffered output cap", () =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      const result = yield* run({
        operation: "test.stream-output",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(131072) + '\\0S final\\0')"],
        cwd: process.cwd(),
        maxOutputBytes: 8,
        onStdoutChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.stdout).toBe("xxxxxxxx");
      expect(result.stdoutTruncated).toBe(true);
      expect(Buffer.concat(chunks).toString()).toBe("x".repeat(131072) + "\0S final\0");
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
