import type { ProgramAttemptCheckout } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class PreparedWorktreeVerificationError extends Schema.TaggedErrorClass<PreparedWorktreeVerificationError>()(
  "PreparedWorktreeVerificationError",
  {
    reason: Schema.Literals([
      "path_unavailable",
      "repository_root_mismatch",
      "git_common_dir_mismatch",
      "worktree_not_registered",
      "worktree_root_mismatch",
      "detached_head",
      "branch_mismatch",
      "commit_mismatch",
      "dirty_worktree",
      "git_command_failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface PreparedWorktreeVerification {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly startingCommit: string;
}

export class PreparedWorktreeVerifier extends Context.Service<
  PreparedWorktreeVerifier,
  {
    readonly verify: (
      checkout: ProgramAttemptCheckout,
      projectWorkspaceRoot: string,
    ) => Effect.Effect<PreparedWorktreeVerification, PreparedWorktreeVerificationError>;
  }
>()("t3/orchestration-v2/PreparedWorktreeVerifier") {}

interface RegisteredWorktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
}

function parseRegisteredWorktrees(output: string): ReadonlyArray<RegisteredWorktree> {
  const worktrees: RegisteredWorktree[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      if (current.path !== undefined) {
        worktrees.push({
          path: current.path,
          head: current.head ?? null,
          branch: current.branch?.replace(/^refs\/heads\//, "") ?? null,
        });
      }
      current = {};
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = value;
  }
  return worktrees;
}

export const layer = Layer.effect(
  PreparedWorktreeVerifier,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;

    const fail = (
      reason: PreparedWorktreeVerificationError["reason"],
      detail: string,
      cause?: unknown,
    ) =>
      Effect.fail(
        new PreparedWorktreeVerificationError({
          reason,
          detail,
          ...(cause === undefined ? {} : { cause }),
        }),
      );

    const realPath = (label: string, value: string) =>
      fs.realPath(value).pipe(
        Effect.map(path.normalize),
        Effect.mapError(
          (cause) =>
            new PreparedWorktreeVerificationError({
              reason: "path_unavailable",
              detail: `${label} is unavailable: ${value}`,
              cause,
            }),
        ),
      );

    const run = Effect.fn("PreparedWorktreeVerifier.runGit")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      return yield* git
        .execute({
          operation: "PreparedWorktreeVerifier.verify",
          cwd,
          args,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 16 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PreparedWorktreeVerificationError({
                reason: "git_command_failed",
                detail: `Git failed while checking ${args.join(" ")}.`,
                cause,
              }),
          ),
        );
    });

    const verify: PreparedWorktreeVerifier["Service"]["verify"] = Effect.fn(
      "PreparedWorktreeVerifier.verify",
    )(function* (checkout, projectWorkspaceRoot) {
      const [repositoryRoot, projectRoot, expectedCommonDir, worktreePath] = yield* Effect.all(
        [
          realPath("repository root", checkout.repositoryRoot),
          realPath("project workspace root", projectWorkspaceRoot),
          realPath("Git common directory", checkout.gitCommonDir),
          realPath("worktree", checkout.worktreePath),
        ],
        { concurrency: 4 },
      );
      if (repositoryRoot !== projectRoot) {
        return yield* fail(
          "repository_root_mismatch",
          `Expected project workspace root ${projectRoot}, received ${repositoryRoot}.`,
        );
      }
      const [repositoryTop, repositoryCommon, worktreeTop, worktreeCommon, branch, head, status] =
        yield* Effect.all(
          [
            run(repositoryRoot, ["rev-parse", "--show-toplevel"]),
            run(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            run(worktreePath, ["rev-parse", "--show-toplevel"]),
            run(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            run(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
            run(worktreePath, ["rev-parse", "HEAD"]),
            run(worktreePath, ["status", "--porcelain=v1", "-z"]),
          ],
          { concurrency: 7 },
        );
      if (repositoryTop.exitCode !== 0) {
        return yield* fail(
          "repository_root_mismatch",
          "The repository root is not a Git worktree.",
        );
      }
      const actualRepositoryRoot = yield* realPath(
        "resolved repository root",
        repositoryTop.stdout.trim(),
      );
      if (actualRepositoryRoot !== repositoryRoot) {
        return yield* fail(
          "repository_root_mismatch",
          `Expected repository root ${repositoryRoot}, received ${actualRepositoryRoot}.`,
        );
      }
      if (repositoryCommon.exitCode !== 0 || worktreeCommon.exitCode !== 0) {
        return yield* fail(
          "git_common_dir_mismatch",
          "Git could not resolve the common directory.",
        );
      }
      const actualRepositoryCommon = yield* realPath(
        "repository Git common directory",
        repositoryCommon.stdout.trim(),
      );
      const actualWorktreeCommon = yield* realPath(
        "worktree Git common directory",
        worktreeCommon.stdout.trim(),
      );
      if (
        actualRepositoryCommon !== expectedCommonDir ||
        actualWorktreeCommon !== expectedCommonDir
      ) {
        return yield* fail(
          "git_common_dir_mismatch",
          `Expected Git common directory ${expectedCommonDir}.`,
        );
      }
      if (worktreeTop.exitCode !== 0) {
        return yield* fail("worktree_root_mismatch", "The prepared path is not a Git worktree.");
      }
      const actualWorktreeRoot = yield* realPath(
        "resolved worktree root",
        worktreeTop.stdout.trim(),
      );
      if (actualWorktreeRoot !== worktreePath) {
        return yield* fail(
          "worktree_root_mismatch",
          `Expected worktree root ${worktreePath}, received ${actualWorktreeRoot}.`,
        );
      }
      const listed = yield* run(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
      if (listed.exitCode !== 0) {
        return yield* fail("worktree_not_registered", "Git could not list registered worktrees.");
      }
      const registeredWorktrees = yield* Effect.forEach(
        parseRegisteredWorktrees(listed.stdout),
        (entry) =>
          fs.realPath(entry.path).pipe(
            Effect.map((resolvedPath) => ({ entry, resolvedPath: path.normalize(resolvedPath) })),
            Effect.catchCause(() => Effect.succeed({ entry, resolvedPath: null })),
          ),
        { concurrency: "unbounded" },
      );
      const registered = registeredWorktrees.find(
        (candidate) => candidate.resolvedPath === worktreePath,
      )?.entry;
      if (registered === undefined) {
        return yield* fail(
          "worktree_not_registered",
          `${worktreePath} is not a registered worktree.`,
        );
      }
      if (branch.exitCode !== 0) {
        return yield* fail("detached_head", `${worktreePath} does not have a symbolic branch.`);
      }
      const actualBranch = branch.stdout.trim();
      if (actualBranch !== checkout.branch || registered.branch !== checkout.branch) {
        return yield* fail(
          "branch_mismatch",
          `Expected branch ${checkout.branch}, received ${actualBranch}.`,
        );
      }
      const actualHead = head.stdout.trim();
      if (
        head.exitCode !== 0 ||
        actualHead !== checkout.startingCommit ||
        registered.head !== checkout.startingCommit
      ) {
        return yield* fail(
          "commit_mismatch",
          `Expected commit ${checkout.startingCommit}, received ${actualHead}.`,
        );
      }
      if (status.exitCode !== 0 || status.stdout.length > 0) {
        return yield* fail("dirty_worktree", `${worktreePath} is not clean.`);
      }
      return {
        repositoryRoot,
        gitCommonDir: expectedCommonDir,
        worktreePath,
        branch: actualBranch,
        startingCommit: actualHead,
      };
    });

    return PreparedWorktreeVerifier.of({ verify });
  }),
);
