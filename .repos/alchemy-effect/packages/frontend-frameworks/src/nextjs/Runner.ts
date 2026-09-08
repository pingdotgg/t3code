import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";

export class RunnerError extends Data.TaggedError<"RunnerError">(
  "RunnerError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The JSON configuration passed to `runner.mjs` (as `process.argv[2]`).
 * Mirrors the shape the runner script parses.
 */
export interface RunnerConfig {
  /** The Next.js app root (the directory containing `open-next.config.ts`). */
  readonly appDir: string;
  /** Path of the OpenNext config, relative to `appDir`. @default "open-next.config.ts" */
  readonly configPath?: string | undefined;
  /** `compatibility_date` of the in-memory wrangler-config stand-in. */
  readonly compatibilityDate: string;
  /** Skip the internal `next build` (reuse an existing `.next`). @default false */
  readonly skipNextBuild?: boolean | undefined;
  /** Minify the OpenNext bundling steps. @default false */
  readonly minify?: boolean | undefined;
  /** Enable OpenNext debug logging. @default false */
  readonly debug?: boolean | undefined;
  /**
   * The command the pipeline runs to build the Next.js app. Defaults (in the
   * runner) to `npx next build` — NOT the app's `build` script, which by
   * fixture convention is `e2e build` and would recurse into this runner.
   */
  readonly buildCommand?: string | undefined;
}

/** Absolute path of the runner script in the package's `nextjs` directory. */
export const runnerPath = (): string =>
  fileURLToPath(new URL("../nextjs/runner.mjs", import.meta.url));

/**
 * Run the programmatic `@opennextjs/cloudflare` build pipeline in a
 * disposable `node` child process (`runner.mjs`). The pipeline mutates
 * cwd-coupled module state, spawns `next build`, and can `process.exit(1)`,
 * so it must never run inside the calling process.
 *
 * Output is piped and re-emitted through the parent's own
 * `process.stdout`/`process.stderr` JS streams — NOT `stdio: "inherit"`.
 * `inherit` writes straight to the process file descriptors, bypassing any
 * in-process stdout capture (e.g. a test runner's log file), which silently
 * discards `next build`'s failure output when the pipeline exits non-zero.
 */
export const runOpenNextBuild = (
  config: RunnerConfig,
): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(
        "node",
        [runnerPath(), JSON.stringify(config)],
        {
          cwd: config.appDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RunnerError({
              message:
                "Failed to spawn the OpenNext build runner (is `node` on PATH?)",
              cause,
            }),
        ),
      );
      const forward = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        dest: NodeJS.WriteStream,
      ) =>
        Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => dest.write(chunk)),
        );
      const { exitCode } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: forward(child.stdout, process.stdout),
          stderr: forward(child.stderr, process.stderr),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new RunnerError({
              message: "Failed reading the OpenNext build runner's output",
              cause,
            }),
        ),
      );
      if (exitCode !== 0) {
        return yield* new RunnerError({
          message: `The OpenNext build pipeline exited with code ${exitCode}`,
        });
      }
    }),
  );
