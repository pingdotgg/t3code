import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
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
  it.effect("retains exit diagnostics when stderr stays open after stdout ends", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const captured = yield* Deferred.make<void>();
      const stderr = Stream.make(new TextEncoder().encode("Error: invalid config\n")).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(captured, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.never),
      );
      const tail = yield* makeStderrTail(stderr);
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: makeChildStdio({ stdout: stdio.stdin, stdin: stdio.stdout() }, tail.awaitDrained),
        terminationError: makeTerminationError(
          {
            pid: ChildProcessSpawner.ProcessId(55),
            exitCode: Deferred.await(exited),
          },
          tail.read,
        ),
      });
      const pending = yield* transport.request("thread/read", {}).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
        Effect.forkScoped,
      );
      yield* Queue.take(output);
      yield* Deferred.await(captured);
      yield* Queue.end(input);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust("250 millis");
      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: invalid config",
      );
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
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
          exitCode: Effect.fail(cause),
        },
        Effect.succeed(""),
      );

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );

  it.effect("names the stderr error line when the process exits", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
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
