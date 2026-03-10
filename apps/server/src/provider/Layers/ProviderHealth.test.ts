import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  checkCodexProviderStatus,
  hasCustomModelProvider,
  parseAuthStatusFromOutput,
  readCodexConfigModelProvider,
} from "./ProviderHealth";

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

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-test-codex-" });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = tmpDir;
        return originalCodexHome;
      }),
      (originalCodexHome) =>
        Effect.sync(() => {
          if (originalCodexHome !== undefined) {
            process.env.CODEX_HOME = originalCodexHome;
          } else {
            delete process.env.CODEX_HOME;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir } as const;
  });
}

it.layer(NodeServices.layer)("ProviderHealth", (it) => {
  // ── checkCodexProviderStatus tests ────────────────────────────────
  //
  // These tests control CODEX_HOME to ensure the custom-provider detection
  // in hasCustomModelProvider() does not interfere with the auth-probe
  // path being tested.

  describe("checkCodexProviderStatus", () => {
    it.effect("returns ready when codex is installed and authenticated", () =>
      Effect.gen(function* () {
        // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
        // default code path (OpenAI provider, auth probe runs) is exercised.
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
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
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("returns unavailable when codex is below the minimum supported version", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth probe reports login required", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
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
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when login status command is unsupported", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI authentication status command is unavailable in this Codex version.",
        );
      }).pipe(
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
  });

  // ── Custom model provider: checkCodexProviderStatus integration ───

  describe("checkCodexProviderStatus with custom model provider", () => {
    it.effect("skips auth probe and returns ready when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          // The spawner only handles --version; if the test attempts
          // "login status" the throw proves the auth probe was NOT skipped.
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still reports error when codex CLI is missing even with custom provider", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );
  });

  describe("checkCodexProviderStatus with openai model provider", () => {
    it.effect("still runs auth probe when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const status = yield* checkCodexProviderStatus;
        // The auth probe runs and sees "not logged in" → error
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseAuthStatusFromOutput pure tests ──────────────────────────

  describe("parseAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.authStatus, "authenticated");
    });

    it("JSON with authenticated=false is unauthenticated", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"authenticated":false}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"ok":true}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });

  // ── readCodexConfigModelProvider tests ─────────────────────────────

  describe("readCodexConfigModelProvider", () => {
    it.effect("returns undefined when config file does not exist", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns undefined when config has no model_provider key", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("returns the provider when model_provider is set at top level", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "portkey");
      }),
    );

    it.effect("returns openai when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider, "openai");
      }),
    );

    it.effect("ignores model_provider inside section headers", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model = "gpt-5-codex"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'model_provider = "should-be-ignored"',
            "",
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, undefined);
      }),
    );

    it.effect("handles comments and whitespace", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            "# This is a comment",
            "",
            '  model_provider = "azure"  ',
            "",
            "[profiles.deep-review]",
            'model = "gpt-5-pro"',
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider, "azure");
      }),
    );

    it.effect("handles single-quoted values in TOML", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome("model_provider = 'mistral'\n");
        assert.strictEqual(yield* readCodexConfigModelProvider, "mistral");
      }),
    );
  });

  // ── hasCustomModelProvider tests ───────────────────────────────────

  describe("hasCustomModelProvider", () => {
    it.effect("returns false when no config file exists", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is not set", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns true when model_provider is portkey", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "portkey"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is azure", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "azure"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is ollama", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "ollama"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is a custom proxy", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );
  });
});
