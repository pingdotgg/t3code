import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import * as CodexProtocol from "../protocol.ts";
import {
  appendStderrTail,
  makeTerminationError,
  stderrExcerpt,
  makeInMemoryStdio,
  makeStderrTail,
  makeChildStdio,
} from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect.each([
    { name: "stdout closes", stdoutEnds: true, signal: false },
    { name: "stdout remains open", stdoutEnds: false, signal: false },
    { name: "stdout remains open after a signal", stdoutEnds: false, signal: true },
  ])("drains final output when $name", ({ stdoutEnds, signal }) =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const captured = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const finalReply = yield* Deferred.make<unknown>();
      const notifications = yield* Ref.make<ReadonlyArray<string>>([]);
      const stderr = Stream.make(new TextEncoder().encode("Error: invalid config\n")).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(captured, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.never),
      );
      const tail = yield* makeStderrTail(stderr);
      const exited = yield* Deferred.make<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
      >();
      const exitFailure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
      });
      const handle = {
        stdout: stdio.stdin,
        stdin: stdio.stdout(),
        pid: ChildProcessSpawner.ProcessId(55),
        isRunning: Effect.succeed(false),
        exitCode: Deferred.await(exited),
      };
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: makeChildStdio(handle, tail.awaitDrained),
        terminationError: makeTerminationError(handle, tail.read),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
        onNotification: ({ method }) => Ref.update(notifications, (all) => [...all, method]),
      });
      const pending = yield* transport.request("thread/read", {}).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
        Effect.forkScoped,
      );
      yield* Queue.take(output);
      yield* transport.request("thread/list", {}).pipe(
        Effect.flatMap((reply) => Deferred.succeed(finalReply, reply)),
        Effect.forkScoped,
      );
      const lastRequest = JSON.parse(yield* Queue.take(output));
      const finalOutput = new TextEncoder().encode(
        `${JSON.stringify({ id: lastRequest.id, result: "final response" })}\n{"method":"turn/completed"}`,
      );
      yield* Deferred.await(captured);
      if (stdoutEnds) {
        yield* Queue.offer(input, finalOutput);
        yield* Queue.end(input);
        yield* TestClock.adjust("100 millis");
      }
      if (signal) yield* Deferred.fail(exited, exitFailure);
      else yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
      if (!stdoutEnds) yield* Queue.offer(input, finalOutput);
      yield* TestClock.adjust("500 millis");
      assert.isTrue(yield* Deferred.isDone(terminated));
      assert.isTrue(yield* Deferred.isDone(finalReply));
      assert.equal(yield* Deferred.await(finalReply), "final response");
      assert.deepEqual(yield* Ref.get(notifications), ["turn/completed"]);
      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(
        error.message,
        signal
          ? "Codex App Server process exited: Error: invalid config"
          : "Codex App Server process exited with code 1: Error: invalid config",
      );
      if (signal) assert.strictEqual(error.cause, exitFailure);
    }),
  );

  it.effect.each([true, false])("retains exit-status diagnostics when isRunning is %s", (running) =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(52),
          isRunning: Effect.succeed(running),
          exitCode: Effect.fail(cause),
        },
        Effect.succeed(""),
      );

      assert.equal(
        error._tag,
        running ? "CodexAppServerTransportError" : "CodexAppServerProcessExitedError",
      );
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        running
          ? "Codex App Server transport operation 'read-process-exit-status' failed."
          : "Codex App Server process exited",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );

  it.effect("names the stderr error line when the process exits", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          isRunning: Effect.succeed(false),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed("Error: Missing optional dependency @openai/codex-darwin-arm64.\n"),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.stderr, "Error: Missing optional dependency @openai/codex-darwin-arm64.");
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: Missing optional dependency @openai/codex-darwin-arm64.",
      );
    }),
  );

  it.effect("keeps the bare exit message when stderr is empty", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(54),
          isRunning: Effect.succeed(false),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed(" \n\n"),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.isUndefined(error.stderr);
      assert.equal(error.message, "Codex App Server process exited with code 1");
    }),
  );
});

describe("Codex App Server stderr excerpt", () => {
  it.each([
    {
      name: "Node launcher missing its platform package",
      stderr: [
        "file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107",
        "  throw new Error(",
        "        ^",
        "",
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
        "    at findCodexExecutable (file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107:9)",
        "    at file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:112:20",
        "",
        "Node.js v26.8.2",
        "",
      ].join("\n"),
      excerpt:
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    },
    {
      name: "Node error with a code",
      stderr:
        "node:internal/modules/esm/resolve:873\n  throw new ERR_MODULE_NOT_FOUND(\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\n",
      excerpt: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
    },
    {
      name: "Rust CLI error",
      stderr: "error: unexpected argument 'app-server' found\n\nUsage: codex [OPTIONS]\n",
      excerpt: "error: unexpected argument 'app-server' found",
    },
    {
      name: "uppercase error label",
      stderr: "ERROR: Missing dependency\nUsage: codex [OPTIONS]\n",
      excerpt: "ERROR: Missing dependency",
    },
    {
      name: "unlabelled message",
      stderr: "WARNING: proceeding without PATH aliases\nMissing OpenAI API key.\n",
      excerpt: "Missing OpenAI API key.",
    },
    {
      name: "launcher exit summary after a DNS failure",
      stderr: [
        "Starting provider",
        'проверить токен LLM: Get "https://llm-gateway.example/api/models": dial tcp: lookup llm-gateway.example: no such host',
        "не удалось отправить метрики на сервер: no such host",
        "Ошибка: ошибка запуска плагина: exit status 1",
      ].join("\n"),
      excerpt:
        'проверить токен LLM: Get "https://llm-gateway.example/api/models": dial tcp: lookup llm-gateway.example: no such host | не удалось отправить метрики на сервер: no such host | Ошибка: ошибка запуска плагина: exit status 1',
    },
    {
      name: "labelled launcher exit summary after an authentication failure",
      stderr: [
        'oauth2: "invalid_request" "Errors.OIDCSession.RefreshTokenInvalid"',
        "Error: provider launcher exited with code 1.",
      ].join("\n"),
      excerpt:
        'oauth2: "invalid_request" "Errors.OIDCSession.RefreshTokenInvalid" | Error: provider launcher exited with code 1.',
    },
    {
      name: "final launcher summary takes precedence over an earlier error label",
      stderr: [
        "Error: starting provider",
        "lookup failed: no such host",
        "Ошибка: exit status 1",
      ].join("\n"),
      excerpt: "Error: starting provider | lookup failed: no such host | Ошибка: exit status 1",
    },
    {
      name: "launcher summary alone",
      stderr: "Error: command failed with exit code 1\n",
      excerpt: "Error: command failed with exit code 1",
    },
    {
      name: "launcher diagnostics remain bounded",
      stderr: `${"x".repeat(1_000)}\noauth2: invalid_request\nError: launcher exited with code 1\n`,
      excerpt: `…${`${"x".repeat(1_000)} | oauth2: invalid_request | Error: launcher exited with code 1`.slice(-511)}`,
    },
    {
      name: "ANSI color, carriage returns and repeated whitespace",
      stderr: "\u001b[31m  Error:\t  config.toml   is invalid \u001b[0m\r\n",
      excerpt: "Error: config.toml is invalid",
    },
    {
      name: "C1 terminal controls",
      stderr: "\u009b31mError: invalid config\u009b0m\nUsage: codex [OPTIONS]\n",
      excerpt: "Error: invalid config",
    },
    {
      name: "oversized line",
      stderr: `Error: ${"x".repeat(1_000)}`,
      excerpt: `Error: ${"x".repeat(504)}…`,
    },
  ])("$name", ({ stderr, excerpt }) => {
    assert.equal(stderrExcerpt(stderr), excerpt);
    assert.isAtMost(excerpt.length, 512);
  });

  it("keeps the Rust fatal cause ahead of the trailing backtrace hint", () => {
    const excerpt = stderrExcerpt(
      [
        "thread 'tokio-rt-worker' (51304) has overflowed its stack",
        "memory allocation of 45408 bytes failed",
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
      ].join("\n"),
    );

    assert.include(excerpt, "memory allocation of 45408 bytes failed");
  });

  it("keeps the Rust panic location ahead of the trailing backtrace hint", () => {
    const excerpt = stderrExcerpt(
      [
        "thread 'main' panicked at codex-rs/core/src/codex.rs:120:5:",
        "called `Option::unwrap()` on a `None` value",
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
      ].join("\n"),
    );

    assert.include(excerpt, "thread 'main' panicked at");
  });

  it("returns nothing for blank stderr", () => {
    assert.isUndefined(stderrExcerpt("\n \t\r\n\u001b[0m\n"));
  });

  it("keeps only the newest stderr", () => {
    const tail = appendStderrTail("a".repeat(8_000), `${"b".repeat(400)}\nError: last`);

    assert.equal(tail.length, 8_192);
    assert.isTrue(tail.endsWith("Error: last"));
    assert.equal(stderrExcerpt(tail), "Error: last");
  });
});
