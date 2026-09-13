import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));

/**
 * Run the CLI with no TTY on any stdio and return its exit code. Each
 * invocation is a real `bun bin/cli.js` child with `ALCHEMY_HOME` pointed at
 * a throwaway directory, so these pin the exit-code contract scripts and
 * agents rely on — 0 only when the command completed — without touching the
 * real `~/.alchemy`.
 */
const exitCodeOf = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  runtime = "bun",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-exit-codes-",
    });
    const handle = yield* ChildProcess.make(runtime, [CLI, ...args], {
      env: { ALCHEMY_HOME: home, ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    return yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe("CLI exit codes", () => {
  it.live("bare `profile` without a terminal prints help and exits 1", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["profile"])).toBe(1);
    }),
  );

  it.live("bare `state` without a terminal prints help and exits 1", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["state"])).toBe(1);
    }),
  );

  it.live("--no-input is accepted and forces a plain, working run", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["--no-input", "profile", "list"])).toBe(0);
    }),
  );

  it.live("--help exits 0", () =>
    Effect.gen(function* () {
      expect(yield* exitCodeOf(["--help"])).toBe(0);
    }),
  );

  // Pins buildless node dev: the launcher must run the checkout's .ts/.tsx
  // source under plain node (type stripping + the register-dev-mode hooks)
  // — --help renders the TSX help view through the full terminal runtime.
  // Stderr is captured: this is the one test in the file whose failure
  // mode is environmental, so "expected 9 to be 0" alone is useless.
  it.live.skipIf(!nodeSupportsDevMode)(
    "--help exits 0 under node from source, no build required",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-exit-codes-",
        });
        const handle = yield* ChildProcess.make(nodePath!, [CLI, "--help"], {
          // The test runner is bun and marks every child's env as
          // bun-invoked; blank the markers so the launcher takes its
          // node path like a real `node bin/cli.js` invocation.
          env: {
            ALCHEMY_HOME: home,
            npm_execpath: "",
            npm_config_user_agent: "",
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: "1 second",
        });
        const [stderr, exitCode] = yield* Effect.all(
          [
            handle.stderr.pipe(
              Stream.decodeText,
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            handle.exitCode,
          ],
          { concurrency: 2 },
        );
        expect({
          exitCode,
          stderr: exitCode === 0 ? "" : stderr,
        }).toEqual({ exitCode: 0, stderr: "" });
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );

  it.live("provider check-env exits 1 when a required var is missing", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(["provider", "check-env", "--provider", "neon"], {
          NEON_API_KEY: "",
        }),
      ).toBe(1);
    }),
  );

  it.live("provider check-env exits 0 when the contract is satisfied", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(["provider", "check-env", "--provider", "neon"], {
          NEON_API_KEY: "napi_test_key",
        }),
      ).toBe(0);
    }),
  );

  it.live("provider check-env accepts an explicit profile", () =>
    Effect.gen(function* () {
      expect(
        yield* exitCodeOf(
          [
            "provider",
            "check-env",
            "--profile",
            "default",
            "--provider",
            "neon",
          ],
          { NEON_API_KEY: "napi_test_key" },
        ),
      ).toBe(0);
    }),
  );
});
