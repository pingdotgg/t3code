import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

/** A bundle larger than one upload can carry is refused; push the branch first. */
export const MAX_HANDOFF_BUNDLE_BYTES = 50 * 1024 * 1024;

/** The work a thread hands off: its branch tip and the working tree on top of it. */
export interface HandoffPackage {
  /** The git bundle: commits not on any remote, plus the snapshot commit. */
  readonly bundlePath: string;
  readonly bundleBytes: number;
  /** The branch the work is on, or null for a detached checkout. */
  readonly branch: string | null;
  /** The branch tip. The thread's committed work ends here. */
  readonly tip: string;
  /** A commit on top of `tip` holding the working tree, untracked files included. */
  readonly snapshot: string;
  /** The remote commit the bundle builds on, for a peer to fetch when it lacks it. */
  readonly baseRemoteUrl: string | null;
}

export class HandoffGitError extends Schema.TaggedError<HandoffGitError>()("HandoffGitError", {
  reason: Schema.Literals([
    "not_a_repository",
    "too_large",
    "missing_base",
    "diverged",
    "checked_out_elsewhere",
    "git_failed",
  ]),
  message: Schema.String,
}) {}

/**
 * Moves a thread's git work between environments as one git bundle: the
 * commits no remote has, and a snapshot commit of the working tree made with
 * a temporary index, as checkpoints are. Applying it never touches a
 * checkout it does not create, moves an existing branch only forward, and
 * undoes everything it did when a step fails.
 */
export class HandoffGit extends Context.Service<
  HandoffGit,
  {
    /** Packages `cwd`'s branch and working tree into a bundle in `outDir`. */
    readonly pack: (input: {
      readonly cwd: string;
      readonly handoffId: string;
      readonly outDir: string;
    }) => Effect.Effect<HandoffPackage, HandoffGitError>;
    /**
     * Applies a package in `repoRoot`: a new worktree at `worktreePath` on its
     * branch, with the working tree as it was. Nothing is left behind on failure.
     */
    readonly apply: (input: {
      readonly repoRoot: string;
      readonly worktreePath: string;
      readonly handoffId: string;
      readonly bundlePath: string;
      readonly branch: string | null;
      readonly tip: string;
      readonly snapshot: string;
    }) => Effect.Effect<{ readonly branch: string | null }, HandoffGitError>;
  }
>()("t3/peer/handoff/HandoffGit") {}

const IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

const handoffRef = (handoffId: string, name: string) => `refs/t3code/handoff/${handoffId}/${name}`;

const make = Effect.gen(function* () {
  const processes = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv; readonly allowNonZeroExit?: boolean } = {},
  ) =>
    processes
      .run({
        operation: "HandoffGit",
        command: "git",
        cwd,
        args,
        timeoutMs: 120_000,
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
        ...(options.allowNonZeroExit === undefined
          ? {}
          : { allowNonZeroExit: options.allowNonZeroExit }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new HandoffGitError({
              reason: "git_failed",
              message: `git ${args[0]} failed: ${error.message}`,
            }),
        ),
      );

  const out = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

  const ok = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args, { allowNonZeroExit: true }).pipe(Effect.map((result) => result.exitCode === 0));

  const pack: HandoffGit["Service"]["pack"] = (input) =>
    Effect.gen(function* () {
      if (!(yield* ok(input.cwd, ["rev-parse", "--verify", "HEAD"]))) {
        return yield* new HandoffGitError({
          reason: "not_a_repository",
          message: `${input.cwd} is not a git checkout with a commit.`,
        });
      }
      const tip = yield* out(input.cwd, ["rev-parse", "HEAD"]);
      const branchName = yield* git(input.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowNonZeroExit: true,
      });
      const branch = branchName.exitCode === 0 ? branchName.stdout.trim() : null;
      const gitDir = yield* out(input.cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
      const indexPath = path.join(gitDir, `t3-handoff-index-${input.handoffId}`);
      // The working tree as a commit on top of the tip, in a private index so
      // the user's staging is untouched. Ignored files stay behind.
      const snapshot = yield* Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: indexPath, ...IDENTITY };
        yield* git(input.cwd, ["read-tree", "HEAD"], { env });
        yield* git(input.cwd, ["add", "--all", "--", "."], { env });
        const tree = (yield* git(input.cwd, ["write-tree"], { env })).stdout.trim();
        return (yield* git(
          input.cwd,
          ["commit-tree", tree, "-p", tip, "-m", `T3 Code handoff ${input.handoffId}`],
          { env },
        )).stdout.trim();
      }).pipe(
        Effect.ensuring(
          Effect.forEach([indexPath, `${indexPath}.lock`], (file) =>
            fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
          ),
        ),
      );
      const snapshotRef = handoffRef(input.handoffId, "snapshot");
      yield* git(input.cwd, ["update-ref", snapshotRef, snapshot]);
      const bundlePath = path.join(input.outDir, `${input.handoffId}.bundle`);
      // Only what no remote has: the peer fetches the rest from the remote.
      yield* git(input.cwd, [
        "bundle",
        "create",
        bundlePath,
        snapshotRef,
        "--not",
        "--remotes",
      ]).pipe(
        Effect.ensuring(git(input.cwd, ["update-ref", "-d", snapshotRef]).pipe(Effect.ignore)),
      );
      const bundleBytes = Number(
        (yield* fileSystem.stat(bundlePath).pipe(
          Effect.mapError(
            () =>
              new HandoffGitError({
                reason: "git_failed",
                message: "The bundle was not written.",
              }),
          ),
        )).size,
      );
      if (bundleBytes > MAX_HANDOFF_BUNDLE_BYTES) {
        yield* fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore);
        return yield* new HandoffGitError({
          reason: "too_large",
          message: `The unpushed work is ${Math.ceil(bundleBytes / 1024 / 1024)} MiB, over the ${MAX_HANDOFF_BUNDLE_BYTES / 1024 / 1024} MiB a handoff carries. Push the branch, then hand off again.`,
        });
      }
      const remote = yield* git(input.cwd, ["remote", "get-url", "origin"], {
        allowNonZeroExit: true,
      });
      return {
        bundlePath,
        bundleBytes,
        branch,
        tip,
        snapshot,
        baseRemoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : null,
      };
    });

  const apply: HandoffGit["Service"]["apply"] = (input) =>
    Effect.gen(function* () {
      const fetched = handoffRef(input.handoffId, "snapshot");
      const undo: Array<Effect.Effect<void>> = [];
      // Read when it runs: the steps are pushed as the apply goes.
      const rollback = Effect.suspend(() =>
        Effect.forEach(undo.toReversed(), (step) => step, { discard: true }),
      );
      return yield* Effect.gen(function* () {
        // The bundle builds on commits the remote has; fetch them if missing.
        if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
          yield* git(input.repoRoot, ["fetch", "--quiet", "origin"], { allowNonZeroExit: true });
          if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
            return yield* new HandoffGitError({
              reason: "missing_base",
              message:
                "This checkout lacks the commits the handoff builds on, even after fetching. Push the branch where it came from, then hand off again.",
            });
          }
        }
        yield* git(input.repoRoot, [
          "fetch",
          "--quiet",
          "--no-tags",
          input.bundlePath,
          `${handoffRef(input.handoffId, "snapshot")}:${fetched}`,
        ]);
        undo.push(git(input.repoRoot, ["update-ref", "-d", fetched]).pipe(Effect.ignore));
        if ((yield* out(input.repoRoot, ["rev-parse", fetched])) !== input.snapshot) {
          return yield* new HandoffGitError({
            reason: "git_failed",
            message: "The bundle does not hold the snapshot it was sent with.",
          });
        }
        // The branch here may only move forward to the tip, and only when no
        // checkout has it, so nobody's work is overwritten.
        let branch = input.branch;
        if (branch !== null) {
          const ref = `refs/heads/${branch}`;
          const existing = yield* git(input.repoRoot, ["rev-parse", "--verify", "--quiet", ref], {
            allowNonZeroExit: true,
          });
          if (existing.exitCode === 0) {
            const current = existing.stdout.trim();
            const checkedOut = (yield* out(input.repoRoot, ["worktree", "list", "--porcelain"]))
              .split("\n")
              .some((line) => line === `branch ${ref}`);
            if (checkedOut && current !== input.tip) {
              return yield* new HandoffGitError({
                reason: "checked_out_elsewhere",
                message: `${branch} is checked out in another worktree here and differs. Switch that checkout off it, then hand off again.`,
              });
            }
            if (current !== input.tip) {
              if (
                !(yield* ok(input.repoRoot, ["merge-base", "--is-ancestor", current, input.tip]))
              ) {
                return yield* new HandoffGitError({
                  reason: "diverged",
                  message: `${branch} here has commits the handed-off work lacks. Reconcile the branches, then hand off again.`,
                });
              }
              // Compare-and-swap: fails if the branch moved since it was read.
              yield* git(input.repoRoot, ["update-ref", ref, input.tip, current]);
              undo.push(
                git(input.repoRoot, ["update-ref", ref, current, input.tip]).pipe(Effect.ignore),
              );
            }
            if (checkedOut) branch = null;
          } else {
            yield* git(input.repoRoot, ["update-ref", ref, input.tip, ""]);
            undo.push(git(input.repoRoot, ["update-ref", "-d", ref]).pipe(Effect.ignore));
          }
        }
        yield* git(
          input.repoRoot,
          branch === null
            ? ["worktree", "add", "--detach", input.worktreePath, input.tip]
            : ["worktree", "add", input.worktreePath, branch],
        );
        undo.push(
          git(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath]).pipe(
            Effect.ignore,
          ),
        );
        // The working tree as it was, untracked files included, then the
        // index back on the tip so the changes show as uncommitted.
        yield* git(input.worktreePath, ["checkout", "--no-overlay", input.snapshot, "--", "."]);
        yield* git(input.worktreePath, ["reset", "--quiet", input.tip]);
        yield* git(input.repoRoot, ["update-ref", "-d", fetched]).pipe(Effect.ignore);
        return { branch };
      }).pipe(Effect.tapError(() => rollback));
    });

  return HandoffGit.of({ pack, apply });
});

export const layer = Layer.effect(HandoffGit, make);
