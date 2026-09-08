/**
 * Child-process isolation for framework production builds.
 *
 * Framework builds load and execute USER code — `astro.config.*`,
 * `nuxt.config.ts` modules, `vite.config.*` plugins, `open-next.config.ts` —
 * which may read `process.cwd()`, mutate `process.env`, or `process.chdir`.
 * Some toolchains additionally require `cwd === project root` outright
 * (kit's postbuild workers re-derive `outDir` from the cwd; waku/rolldown
 * resolve inputs from the cwd). None of that may run inside the engine
 * process, where many deploys share one event loop. The same class of
 * problem alchemy solved for Vite (#1102) and Next.js (`runner.mjs`).
 *
 * Instead, every production build runs in a disposable child process whose
 * working directory IS the project root — no chdir anywhere, no lock,
 * unbounded build concurrency:
 *
 * - The **parent** ({@link runBuildChild}) spawns the shared
 *   `core/BuildChildRunner.ts` entry, forwards the build logs, and reads the
 *   {@link BuildOutput} back from a temp `build.json` (`readBuildOutput`
 *   revives Buffers and the workspaces Set).
 * - The **child** (`BuildChildRunner`) imports the framework's source module
 *   and calls its exported `buildInChild(config)` — a PURE function
 *   returning an Effect (see {@link BuildChildModule}), so importing any
 *   source module never has side effects; process concerns (argv, exit
 *   codes) live only in the runner entry, which is never imported.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { readBuildOutput } from "./BuildOutput.ts";
import type { BuildOutput } from "./BuildOutput.ts";
import { FrameworkError } from "./Framework.ts";

/**
 * The contract a framework source module fulfills to be buildable in a
 * child: a pure `buildInChild` export that turns the JSON config into the
 * build Effect. Tests can call it directly in-process; `runBuildChild`
 * executes it in the shared runner entry.
 */
export interface BuildChildModule {
  readonly buildInChild: (
    config: never,
  ) => Effect.Effect<BuildOutput, unknown, FileSystem.FileSystem | Path.Path>;
}

/** The runner's `argv[2]` payload (JSON). */
export interface BuildChildPayload {
  /** File URL of the framework source module exporting `buildInChild`. */
  readonly module: string;
  /** JSON-serializable config handed to the module's `buildInChild`. */
  readonly config: unknown;
  /** Where the runner persists the resulting `BuildOutput` (build.json). */
  readonly outputPath: string;
}

/**
 * Node CLI flags that transparently strip TypeScript types, so a `.ts`
 * source module works as a child entry when running from `src/` under plain
 * Node (Bun handles `.ts` natively). Mirrors alchemy's
 * `Util/Node.transformTypesFlags`.
 */
const transformTypesFlags = (): Array<string> => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26)
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];
};

export interface BuildChildOptions {
  /**
   * File URL of the module exporting `buildInChild` — pass
   * `import.meta.url`. The shared runner entry (resolved as a sibling of
   * this module's `core/` directory) imports it in the child.
   */
  readonly module: string;
  /** Project root — becomes the child's working directory. */
  readonly rootDir: string;
  /** JSON-serializable config handed to the module's `buildInChild`. */
  readonly config: unknown;
  /** Framework name for error attribution (e.g. "sveltekit", "waku"). */
  readonly framework: string;
  /**
   * Extra process env for the child only. Merged over the parent's env
   * at spawn time so Vite/nitro/`import.meta.env` see site `env` without
   * the parent mutating `process.env` (plugins in the child may still
   * mutate theirs — that is why this is a child).
   */
  readonly env?: Record<string, string> | undefined;
}

/**
 * Run a framework production build in a disposable child process with
 * `cwd = rootDir` and return its {@link BuildOutput}.
 *
 * Build logs are re-emitted through the parent's own `process.stdout` /
 * `process.stderr` JS streams — NOT `stdio: "inherit"` — so in-process
 * capture (a test runner's log file) sees them.
 */
export const runBuildChild = (
  options: BuildChildOptions,
): Effect.Effect<
  BuildOutput,
  FrameworkError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fail =
        (message: string) =>
        (cause?: unknown): FrameworkError =>
          new FrameworkError({
            framework: options.framework,
            message,
            cause,
          });

      const outputDir = yield* fs
        .makeTempDirectoryScoped({ prefix: "alchemy-framework-build-" })
        .pipe(
          Effect.mapError(
            fail("Failed to create the build child's temp directory"),
          ),
        );
      const outputPath = path.join(outputDir, "build.json");

      // The runner entry lives beside this module's core/ directory in both
      // layouts (src/{fw}/source.ts → src/core/BuildChildRunner.ts,
      // dist/{fw}/source.js → dist/core/BuildChildRunner.js), so it resolves
      // relative to the FRAMEWORK module's own stable URL.
      const entry = fileURLToPath(
        new URL(
          options.module.endsWith(".ts")
            ? "../core/BuildChildRunner.ts"
            : "../core/BuildChildRunner.js",
          options.module,
        ),
      );
      const isBun =
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
      const payload: BuildChildPayload = {
        module: options.module,
        config: options.config,
        outputPath,
      };
      const args = [
        ...(isBun
          ? ["run"]
          : entry.endsWith(".ts")
            ? transformTypesFlags()
            : []),
        entry,
        JSON.stringify(payload),
      ];

      const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(FileSystem.FileSystem)(fs),
            Layer.succeed(Path.Path)(path),
          ),
        ),
      );

      const exitCode = yield* Effect.gen(function* () {
        const child = yield* ChildProcess.make(process.execPath, args, {
          cwd: options.rootDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          ...(options.env !== undefined
            ? { env: { ...process.env, ...options.env } }
            : {}),
        }).pipe(
          Effect.mapError(
            fail(
              `Failed to spawn the ${options.framework} build child (${process.execPath})`,
            ),
          ),
        );
        const forward = (
          stream: Stream.Stream<Uint8Array, PlatformError>,
          dest: NodeJS.WriteStream,
        ) =>
          Stream.runForEach(stream, (chunk) =>
            Effect.sync(() => dest.write(chunk)),
          );
        const { code } = yield* Effect.all(
          {
            code: child.exitCode,
            stdout: forward(child.stdout, process.stdout),
            stderr: forward(child.stderr, process.stderr),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            fail(
              `Failed reading the ${options.framework} build child's output`,
            ),
          ),
        );
        return code;
      }).pipe(Effect.provide(spawnerLayer));

      if (exitCode !== 0) {
        return yield* Effect.fail(
          fail(
            `The ${options.framework} build child exited with code ${exitCode}`,
          )(undefined),
        );
      }

      return yield* readBuildOutput(outputPath).pipe(
        Effect.mapError(
          fail(
            `The ${options.framework} build child exited 0 but produced no readable build output`,
          ),
        ),
      );
    }),
  );
