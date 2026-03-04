import { assert, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";

import { checkCodexProviderStatus, parseAuthStatusFromOutput } from "./ProviderHealth";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

// ── Tests ───────────────────────────────────────────────────────────

it.effect("returns ready when codex is installed and authenticated", () =>
  checkCodexProviderStatus.pipe(
    Effect.map((status) => {
      expect(status).toEqual(
        expect.objectContaining({
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
        }),
      );
    }),
    Effect.provide(
      mockSpawnerLayer((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect("returns unavailable when codex is missing", () =>
  checkCodexProviderStatus.pipe(
    Effect.map((status) => {
      expect(status).toEqual(
        expect.objectContaining({
          provider: "codex",
          status: "error",
          available: false,
          authStatus: "unknown",
          message: "Codex CLI (`codex`) is not installed or not on PATH.",
        }),
      );
    }),
    Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
  ),
);

it.effect("returns unauthenticated when auth probe reports login required", () =>
  checkCodexProviderStatus.pipe(
    Effect.map((status) => {
      expect(status).toEqual(
        expect.objectContaining({
          provider: "codex",
          status: "error",
          available: true,
          authStatus: "unauthenticated",
          message: "Codex CLI is not authenticated. Run `codex login` and try again.",
        }),
      );
    }),
    Effect.provide(
      mockSpawnerLayer((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
  checkCodexProviderStatus.pipe(
    Effect.map((status) => {
      expect(status).toEqual(
        expect.objectContaining({
          provider: "codex",
          status: "error",
          available: true,
          authStatus: "unauthenticated",
          message: "Codex CLI is not authenticated. Run `codex login` and try again.",
        }),
      );
    }),
    Effect.provide(
      mockSpawnerLayer((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") return { stdout: "Not logged in\n", stderr: "", code: 1 };
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect("returns warning when login status command is unsupported", () =>
  checkCodexProviderStatus.pipe(
    Effect.map((status) => {
      expect(status).toEqual(
        expect.objectContaining({
          provider: "codex",
          status: "warning",
          available: true,
          authStatus: "unknown",
          message: "Codex CLI authentication status command is unavailable in this Codex version.",
        }),
      );
    }),
    Effect.provide(
      mockSpawnerLayer((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

// ── Pure function tests ─────────────────────────────────────────────

it("parseAuthStatusFromOutput: exit code 0 with no auth markers is ready", () => {
  const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
  assert.strictEqual(parsed.status, "ready");
  assert.strictEqual(parsed.authStatus, "authenticated");
});

it("parseAuthStatusFromOutput: JSON with authenticated=false is unauthenticated", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"authenticated":false}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "error");
  assert.strictEqual(parsed.authStatus, "unauthenticated");
});

it("parseAuthStatusFromOutput: JSON without auth marker is warning", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"ok":true}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "warning");
  assert.strictEqual(parsed.authStatus, "unknown");
});
