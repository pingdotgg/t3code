import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface CommandProps {
  /**
   * The shell command to run for the build.
   * @example "npm run build"
   * @example "vite build"
   */
  command: string;
  /**
   * Working directory for the command.
   * Defaults to the current working directory.
   */
  cwd?: string;
  /**
   * Controls which files are hashed to decide whether the build should re-run.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope.
   *
   * @see {@link MemoOptions}
   */
  memo?: MemoOptions;
  /**
   * The output path (file or directory) produced by the build.
   * This path is relative to the working directory.
   * @example "dist"
   */
  outdir: string;
  /**
   * Environment variables to pass to the build command.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
}

export interface Command extends Resource<
  "Build.Command",
  CommandProps,
  {
    /**
     * Absolute path to the build output.
     */
    outdir: string;
    /**
     * Hash of the input files that produced this build.
     */
    hash: string;
  }
> {}

/**
 * A Build resource that runs a shell command and produces an output asset.
 * Input files are hashed using globs to avoid redundant rebuilds.
 *
 * @section Building a Vite App
 * @example Basic Vite Build
 * ```typescript
 * const build = yield* Build("vite-build", {
 *   command: "npm run build",
 *   cwd: "./frontend",
 *   outdir: "dist",
 * });
 * yield* Console.log(build.path); // absolute path to dist directory
 * yield* Console.log(build.hash); // hash of input files
 * ```
 *
 * @section Building with Custom Environment
 * @example Build with Environment Variables
 * ```typescript
 * const build = yield* Build("production-build", {
 *   command: "npm run build",
 *   cwd: "./app",
 *   output: "dist",
 *   env: {
 *     NODE_ENV: "production",
 *     API_URL: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * @section Customizing Memoization
 * @example Customize Memoization
 * ```typescript
 * const build = yield* Build("custom-build", {
 *   command: "npm run build",
 *   cwd: "./app",
 *   output: "dist",
 *   memo: { include: ["src/*", "package.json"], exclude: ["node_modules", "dist"] },
 * });
 */
export const Command = Resource<Command>("Build.Command");

export const CommandProvider = () =>
  Provider.effect(
    Command,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathModule = yield* Path.Path;

      const runBuild = (props: CommandProps) =>
        Effect.gen(function* () {
          const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
          yield* runBuildCommand({
            command: props.command,
            cwd,
            env: props.env
              ? Object.fromEntries(
                  Object.entries(props.env).map(([key, value]) => [
                    key,
                    typeof value === "string" ? value : Redacted.value(value),
                  ]),
                )
              : undefined,
          });
        });

      const getOutputPath = (props: CommandProps) => {
        const cwd = props.cwd ? pathModule.resolve(props.cwd) : process.cwd();
        return pathModule.resolve(cwd, props.outdir);
      };

      return Command.Provider.of({
        stables: ["outdir"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) {
            return undefined;
          }
          const newHash = yield* hashDirectory(news);
          if (newHash !== output.hash) {
            return { action: "update" as const };
          }
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          if (!output) {
            return undefined;
          }
          // Recompute the output path against the *current* cwd. State
          // may have been written by a different machine (e.g. CI) and
          // the absolute path baked into `output.outdir` won't exist
          // locally. As long as the path resolved against this
          // machine's cwd is present, return the refreshed output so
          // downstream consumers (e.g. `Cloudflare.Worker` assets)
          // don't try to read a stale, foreign-machine path.
          const outputPath = getOutputPath(olds);
          const exists = yield* fs.exists(outputPath);
          if (!exists) {
            return undefined;
          }
          return { ...output, outdir: outputPath };
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          // Observe — the build artifact is a local directory keyed by the
          // hash of its inputs. The previous run's `output.hash` is our
          // cache; recompute against the current sources to detect drift.
          const desiredHash = yield* hashDirectory(news);
          const outputPath = getOutputPath(news);
          const cachedExists =
            output !== undefined && (yield* fs.exists(output.outdir));
          const reusable =
            cachedExists &&
            output!.hash === desiredHash &&
            output!.outdir === outputPath;

          // Ensure — when the cached artifact is missing, stale, or the
          // output path moved, run the build. The build command itself is
          // responsible for producing `outputPath`.
          if (!reusable) {
            yield* session.note(
              output === undefined
                ? `Running build: ${news.command}`
                : `Rebuilding: ${news.command}`,
            );
            yield* runBuild(news);
            const exists = yield* fs.exists(outputPath);
            if (!exists) {
              return yield* Effect.die(
                `Build completed but output path does not exist: ${outputPath}`,
              );
            }
            yield* session.note(
              output === undefined
                ? `Build completed: ${outputPath}`
                : `Rebuild completed: ${outputPath}`,
            );
          }

          // Return — the artifact location and the hash that produced it.
          return {
            outdir: outputPath,
            hash: desiredHash,
          };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const exists = yield* fs.exists(output.outdir);
          if (exists) {
            yield* fs.remove(output.outdir, { recursive: true });
            yield* session.note(`Removed build output: ${output.outdir}`);
          }
        }),
      });
    }),
  );

export interface RunBuildCommandOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export const execBuildCommand = Effect.fnUntraced(function* (
  command: ChildProcess.Command,
) {
  const handle = yield* command;
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ] as const,
    { concurrency: 3 },
  );
  return { exitCode, stdout, stderr };
});

export const runBuildCommand = Effect.fnUntraced(function* ({
  command,
  cwd,
  env,
}: RunBuildCommandOptions) {
  const child = ChildProcess.setCwd(
    ChildProcess.make(command, [], {
      shell: true,
      env: { ...process.env, ...env },
    }),
    cwd ?? process.cwd(),
  );

  const result = yield* execBuildCommand(child).pipe(Effect.orDie);

  if (result.exitCode !== 0) {
    return yield* Effect.die(
      `Build command failed with exit code ${result.exitCode}${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }

  yield* Effect.logDebug("Build output", result.stdout);
  if (result.stderr) {
    yield* Effect.logDebug("Build stderr", result.stderr);
  }

  return result;
});
