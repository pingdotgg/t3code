import * as Effect from "effect/Effect";
import { havePropsChanged, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { CommandExecutor, type CommandProps } from "./Command.ts";
import { hashDirectory, type MemoOptions } from "./Memo.ts";

export interface ExecProps extends CommandProps {
  /**
   * Controls which files are hashed to decide whether the command should
   * re-run. By default every non-gitignored file in `cwd` is hashed, plus the
   * nearest lockfile. Provide explicit globs to narrow the scope, or set
   * `false` to disable memoization and re-run on every deploy.
   *
   * @see {@link MemoOptions}
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface Exec extends Resource<
  "Command.Exec",
  ExecProps,
  {
    /**
     * Hash of the input files for this command, if memoization is enabled.
     */
    hash: {
      input: string | undefined;
    };
  }
> {}

/**
 * An `Exec` runs a shell command purely for its side effects — it has no
 * output contract. Unlike `Build`, it does not produce or track an output
 * asset; `reconcile` runs the command and the resource succeeds as long as the
 * command exits with code `0` (a non-zero exit fails with a `CommandError`).
 *
 * Use it for one-off setup steps — running migrations, seeding data, code
 * generation, or any command whose result lives outside Alchemy's state. By
 * default the input files are content-hashed so the command only re-runs when
 * its inputs (or `command`/`cwd`/`env`) change; set `memo: false` to re-run on
 * every deploy.
 *
 * @resource
 * @section Running a Command
 * @example Run a One-Off Command
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   cwd: "./packages/api",
 * });
 * ```
 *
 * @section Running with Custom Environment
 * @example Run Database Migrations
 * ```typescript
 * yield* Exec("migrate", {
 *   command: "npm run db:migrate",
 *   env: {
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 *
 * @section Memoizing Re-Runs
 * @example Only Re-Run When Inputs Change
 * ```typescript
 * yield* Exec("codegen", {
 *   command: "npm run codegen",
 *   memo: { include: ["schema/**"] },
 * });
 * ```
 */
export const Exec = Resource<Exec>("Command.Exec");

export const ExecProvider = () =>
  Provider.effect(
    Exec,
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;

          // Always update if memoization is disabled or input hash is not available.
          if (news.memo === false || !output.hash.input)
            return { action: "update" };

          // Optimization: short-circuit if props have changed to avoid unnecessary file system operations.
          if (havePropsChanged(olds, news)) return { action: "update" };

          const newHash = yield* hashDirectory({
            cwd: news.cwd,
            memo: news.memo === true ? {} : news.memo,
          });
          return {
            action: newHash === output.hash.input ? "noop" : "update",
          };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* run(news, session);
          return {
            hash: {
              input:
                news.memo === false
                  ? undefined
                  : yield* hashDirectory({
                      cwd: news.cwd,
                      memo: news.memo === true ? {} : news.memo,
                    }),
            },
          };
        }),
        delete: () => Effect.void,
      };
    }),
  );
