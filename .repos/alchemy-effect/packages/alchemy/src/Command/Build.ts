import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { initialCwd } from "../Util/Node.ts";
import { sha256Object } from "../Util/sha256.ts";
import {
  CommandExecutor,
  OutputNotFound,
  makeCommandError,
  type CommandRunProps,
} from "./Command.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface BuildProps extends CommandRunProps {
  /**
   * The output path (file or directory) produced by the build.
   * This path is relative to the working directory.
   * @example "dist"
   */
  outdir: string;
  /**
   * Controls which files are hashed to decide whether the build should re-run.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope, or set `false` to
   * disable memoization and rebuild on every deploy.
   *
   * @see {@link MemoOptions}
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface Build extends Resource<
  "Command.Build",
  BuildProps,
  {
    /**
     * Path to the build output, relative to the process's initial working
     * directory (`initialCwd` — captured at startup, immune to transient
     * chdir by tools sharing the process).
     *
     * Stored relative (rather than absolute) so the value is portable across
     * machines — state written by a CI runner
     * (`/home/runner/work/.../dist`) resolves correctly on a local laptop and
     * vice versa. Consumers should resolve it against `initialCwd` to obtain
     * an absolute path.
     */
    outdir: string;
    hash: {
      /**
       * Hash of the input files that produced this build.
       */
      input: string | undefined;
      /**
       * Hash of the output files from this build.
       */
      output: string | undefined;
    };
  }
> {}

/**
 * A `Build` runs a shell command that produces an output asset (a file or
 * directory) and tracks that asset in state. Unlike `Exec`, a `Build` has an
 * output contract: `reconcile` verifies the command actually produced `outdir`
 * and exposes its location so downstream resources (e.g. a `Cloudflare.Worker`'s
 * static assets) can consume it.
 *
 * Inputs are content-hashed by default so an unchanged project skips the
 * rebuild entirely; set `memo: false` to rebuild on every deploy.
 *
 * ### Building a Vite App
 * **Example:** Basic Vite Build
 * ```typescript
 * const build = yield* Build("vite-build", {
 *   command: "npm run build",
 *   cwd: "./frontend",
 *   outdir: "dist",
 * });
 * yield* Console.log(build.outdir); // path to the dist directory, relative to the initial cwd
 * yield* Console.log(build.hash.output); // hash of the output files (when memo is enabled)
 * ```
 *
 * ### Building with Custom Environment
 * **Example:** Build with Environment Variables
 * ```typescript
 * const build = yield* Build("production-build", {
 *   command: "npm run build",
 *   cwd: "./app",
 *   outdir: "dist",
 *   env: {
 *     NODE_ENV: "production",
 *     API_URL: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * ### Customizing Memoization
 * **Example:** Customize Memoization
 * ```typescript
 * const build = yield* Build("custom-build", {
 *   command: "npm run build",
 *   cwd: "./app",
 *   outdir: "dist",
 *   memo: { include: ["src/**", "package.json"], exclude: ["node_modules", "dist"] },
 * });
 * ```
 *
 * @resource
 */
export const Build = Resource<Build>("Command.Build");

/**
 * Resolves `Redacted` env values to their plain string so that a change in a
 * secret's value still busts the memo hash (the hash is one-way, so the secret
 * itself is never recoverable from state). `undefined`-valued entries are
 * dropped (they mean "unset").
 */
const resolveEnv = (env: CommandRunProps["env"]) =>
  env
    ? Object.fromEntries(
        Object.entries(env)
          .filter(
            (entry): entry is [string, string | Redacted.Redacted<string>] =>
              entry[1] !== undefined,
          )
          .map(([key, value]) => [
            key,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
      )
    : undefined;

export const BuildProvider = () =>
  Provider.effect(
    Build,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { run } = yield* CommandExecutor;

      const makeOutput = Effect.fn(function* (props: BuildProps) {
        // Anchored to the initial cwd: a live `process.cwd()` read can race
        // a concurrent tool's transient chdir (framework source builds),
        // and the relative `outdir` stored here is resolved again later
        // (assets read) — mismatched bases corrupt the path.
        const cwd = path.resolve(initialCwd, props.cwd ?? ".");
        const outdir = path.resolve(cwd, props.outdir);
        if (!(yield* fs.exists(outdir))) {
          return yield* makeCommandError(
            props,
            new OutputNotFound({
              outdir: props.outdir,
            }),
          );
        }
        return {
          outdir: path.relative(initialCwd, outdir),
          hash:
            props.memo === false
              ? { input: undefined, output: undefined }
              : yield* Effect.all(
                  {
                    // Fold the resolved command + env into the input hash so
                    // two builds that share the same source tree + `outdir`
                    // but differ in their command or environment (e.g.
                    // per-stage builds baking different `EXPO_PUBLIC_*` /
                    // API ids) are never judged reusable. Without this the
                    // second build silently reuses the first's stale output.
                    input: hashDirectory({
                      cwd,
                      memo: props.memo === true ? {} : props.memo,
                    }).pipe(
                      Effect.flatMap((files) =>
                        sha256Object({
                          files,
                          command: props.command,
                          env: resolveEnv(props.env),
                        }),
                      ),
                    ),
                    output: hashDirectory({
                      cwd: outdir,
                      memo: {
                        exclude: [],
                        lockfile: false,
                      },
                    }),
                  },
                  { concurrency: "unbounded" },
                ),
        };
      });

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          // Always update if memoization is disabled or hashes are not available.
          if (news.memo === false || !output.hash.input || !output.hash.output)
            return { action: "update" };

          // Optimization: short-circuit if props have changed to avoid unnecessary file system operations.
          if (havePropsChanged(olds, news)) return { action: "update" };

          const newOutput = yield* makeOutput(news).pipe(
            Effect.catchReason(
              "CommandError",
              "OutputNotFound",
              () => Effect.undefined,
            ),
          );
          return {
            action: Equal.equals(newOutput, output) ? "noop" : "update",
          };
        }),
        reconcile: ({ news, session }) =>
          run(news, session).pipe(Effect.andThen(makeOutput(news))),
        delete: Effect.fn(function* ({ output }) {
          // `output.outdir` is persisted relative to the initial cwd.
          const outdir = path.resolve(initialCwd, output.outdir);
          if (!(yield* fs.exists(outdir))) return;
          yield* fs.remove(outdir, { recursive: true });
        }),
      };
    }),
  );
