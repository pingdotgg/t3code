import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
  /** The Next.js application root. */
  readonly appDir: string;
  /** Explicit config relative to `appDir`; otherwise discover `open-next.config.ts`. */
  readonly configPath?: string | undefined;
  /** Resource-selected cache configuration when no native config file is present. */
  readonly cache?: "static-assets" | "kv" | undefined;
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

const BuildPaths = Schema.Struct({
  openNextDirectory: Schema.String,
  appBuildOutputPath: Schema.String,
});

/** Discover the same default filename as the native Cloudflare OpenNext CLI. */
export const resolveConfigPath = Effect.fn(function* (
  config: Pick<RunnerConfig, "appDir" | "configPath">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = path.resolve(
    config.appDir,
    config.configPath ?? "open-next.config.ts",
  );
  if (yield* fs.exists(candidate)) {
    if ((yield* fs.stat(candidate)).type !== "File") {
      return yield* new RunnerError({
        message: `OpenNext config is not a file: ${candidate}`,
      });
    }
    return candidate;
  }
  if (config.configPath !== undefined) {
    return yield* new RunnerError({
      message: `OpenNext config file not found: ${candidate}`,
    });
  }
  return undefined;
});

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
): Effect.Effect<
  typeof BuildPaths.Type,
  RunnerError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configPath = yield* resolveConfigPath(config);
      // The parent owns cleanup even if OpenNext calls process.exit in the child.
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-nextjs-config-",
      });
      const outputPath = path.join(directory, "build-paths.json");
      const child = yield* ChildProcess.make(
        "node",
        [
          runnerPath(),
          JSON.stringify({
            ...config,
            configPath,
            generatedConfigPath:
              configPath === undefined
                ? path.join(directory, "open-next.config.mjs")
                : undefined,
            outputPath,
          }),
        ],
        {
          cwd: config.appDir,
          // Keep upstream compiler scratch files inside the parent's scope too.
          env: { TMPDIR: directory, TMP: directory, TEMP: directory },
          extendEnv: true,
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
      return yield* fs
        .readFileString(outputPath)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(BuildPaths)),
          ),
        );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RunnerError
          ? cause
          : new RunnerError({
              message:
                "Failed to prepare or read the OpenNext build configuration",
              cause,
            }),
      ),
    ),
  );
