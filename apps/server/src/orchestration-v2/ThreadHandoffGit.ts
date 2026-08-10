import type { VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/**
 * How an incoming branch tip relates to the one the receiving repository is
 * already sitting on.
 *
 * The whole safety model of a handoff reduces to this classification, and to
 * the rule it enforces: a branch tip only ever moves to a descendant of
 * itself, on either machine. `advance` is the only outcome that moves a
 * pointer forward, `absorb` keeps the local tip and merges the sender's
 * working state on top of it, and the remaining two write nothing at all.
 */
export type HandoffTipClassification = "advance" | "absorb" | "diverged" | "unrelated";

export interface ClassifyIncomingTipInput {
  /** Null when the receiving repository has no such branch yet. */
  readonly localTip: string | null;
  readonly incomingTip: string;
  /** The incoming commit has the local tip in its ancestry. */
  readonly incomingContainsLocal: boolean;
  /** The local tip has the incoming commit in its ancestry. */
  readonly localContainsIncoming: boolean;
  /** The two commits share any ancestor at all. */
  readonly hasCommonAncestor: boolean;
}

export function classifyIncomingTip(input: ClassifyIncomingTipInput): HandoffTipClassification {
  if (input.localTip === null) return "advance";
  if (input.localTip === input.incomingTip) return "absorb";
  // Containment is checked before common ancestry: a commit that contains the
  // other trivially shares history with it, and answering "unrelated" for a
  // fast-forward would refuse a transfer that is safe by construction.
  if (input.incomingContainsLocal) return "advance";
  if (input.localContainsIncoming) return "absorb";
  return input.hasCommonAncestor ? "diverged" : "unrelated";
}

/**
 * Where the sender's commits are parked when a hop is refused. The receiving
 * side writes them under its own namespace before deciding, so a refusal still
 * leaves the user holding both histories and able to join them by hand.
 */
export function handoffRefName(
  environmentId: string,
  branch: string,
  // Call sites should pass the handoff id: without it two refused handoffs on
  // the same environment/branch write the same ref, and the first parked
  // commit loses its only reference.
  handoffId?: string,
): string {
  const scope = handoffId === undefined ? "" : `${refSafe(handoffId)}/`;
  return `refs/handoff/${refSafe(environmentId)}/${scope}${refSafe(branch)}`;
}

/** Tag written over the old tip before any pointer moves. */
export function handoffPreTagName(handoffId: string): string {
  return `handoff-pre-${refSafe(handoffId)}`;
}

/** Stash label for a dirty receiving worktree; the base sha makes a later pop legible. */
export function handoffStashLabel(handoffId: string, baseSha: string): string {
  return `handoff-overwritten-${refSafe(handoffId)}-base-${refSafe(baseSha)}`;
}

/**
 * Ids and branch names are only branded non-empty strings, but they end up
 * inside git ref names, where a space, `~`, `:` or `..` makes git reject the
 * whole operation. Everything outside git's safe alphabet becomes `-`.
 */
function refSafe(value: string): string {
  return value
    .replaceAll(/[^A-Za-z0-9._/-]/g, "-")
    .replaceAll("..", "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

/**
 * A sender's untracked file would overwrite a file the receiving worktree
 * tracks. Raised before anything is extracted, so refusing loses nothing.
 */
export class HandoffUntrackedCollisionError extends Schema.TaggedErrorClass<HandoffUntrackedCollisionError>()(
  "HandoffUntrackedCollisionError",
  {
    cwd: Schema.String,
    /** A bounded sample of the colliding paths. */
    collisions: Schema.Array(Schema.String),
    collisionCount: Schema.Number,
  },
) {
  override get message(): string {
    const sample = this.collisions.join(", ");
    const suffix = this.collisionCount > this.collisions.length ? ", …" : "";
    return `Untracked files from the sender collide with tracked files here: ${sample}${suffix}.`;
  }
}

/** Big enough for any diff the payload ceiling would accept, small enough to fail fast. */
const PATCH_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** File lists are far smaller than diffs. */
const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface GitInput {
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

const runGit = (process: VcsProcess.VcsProcess["Service"], input: GitInput) =>
  process.run({
    operation: `thread-handoff.${input.operation}`,
    command: "git",
    args: input.args,
    cwd: input.cwd,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    ...(input.allowNonZeroExit === undefined ? {} : { allowNonZeroExit: input.allowNonZeroExit }),
    ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });

export class ThreadHandoffGit extends Context.Service<
  ThreadHandoffGit,
  {
    /** Current tip of `branch`, or null when the branch does not exist. */
    readonly resolveTip: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<string | null, VcsError>;
    readonly resolveHead: (input: { readonly cwd: string }) => Effect.Effect<string, VcsError>;
    readonly isAncestor: (input: {
      readonly cwd: string;
      readonly ancestor: string;
      readonly descendant: string;
    }) => Effect.Effect<boolean, VcsError>;
    readonly hasCommonAncestor: (input: {
      readonly cwd: string;
      readonly left: string;
      readonly right: string;
    }) => Effect.Effect<boolean, VcsError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly commit: string;
    }) => Effect.Effect<boolean, VcsError>;
    /** Tracked changes against HEAD, binary-safe so images and lockfiles survive. */
    readonly trackedPatch: (input: { readonly cwd: string }) => Effect.Effect<string, VcsError>;
    readonly untrackedPaths: (input: {
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly dirtyFileCount: (input: { readonly cwd: string }) => Effect.Effect<number, VcsError>;
    /** True when `commit` is reachable from any remote-tracking ref, so rewriting it is off the table. */
    readonly isPublished: (input: {
      readonly cwd: string;
      readonly commit: string;
    }) => Effect.Effect<boolean, VcsError>;
    readonly tagCommit: (input: {
      readonly cwd: string;
      readonly tag: string;
      readonly commit: string;
    }) => Effect.Effect<void, VcsError>;
    readonly stashWorktree: (input: {
      readonly cwd: string;
      readonly label: string;
    }) => Effect.Effect<string | null, VcsError>;
    readonly writeRef: (input: {
      readonly cwd: string;
      readonly ref: string;
      readonly commit: string;
    }) => Effect.Effect<void, VcsError>;
    /**
     * Writes a bundle carrying `refs`, excluding anything the receiver already
     * has. With no exclusions this is full history, which is what lets a
     * repository the target has never seen arrive without a remote, credentials,
     * or network.
     */
    readonly createBundle: (input: {
      readonly cwd: string;
      readonly outputPath: string;
      readonly refs: ReadonlyArray<string>;
      readonly excludeTips: ReadonlyArray<string>;
    }) => Effect.Effect<boolean, VcsError>;
    /** Imports a bundle's objects and parks its refs under `refs/handoff-incoming/`. */
    readonly importBundle: (input: {
      readonly cwd: string;
      readonly bundlePath: string;
    }) => Effect.Effect<void, VcsError>;
    readonly cloneFromBundle: (input: {
      readonly bundlePath: string;
      readonly targetPath: string;
      readonly branch: string | null;
    }) => Effect.Effect<void, VcsError>;
    /**
     * Applies a tracked-changes patch. `check` runs the same apply as a dry run,
     * which is what lets a hop refuse before touching the working tree.
     */
    readonly applyPatch: (input: {
      readonly cwd: string;
      readonly patch: string;
      readonly check: boolean;
    }) => Effect.Effect<boolean, VcsError>;
    readonly checkoutBranchAt: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly commit: string;
    }) => Effect.Effect<void, VcsError>;
    readonly resetHardTo: (input: {
      readonly cwd: string;
      readonly commit: string;
    }) => Effect.Effect<void, VcsError>;
    readonly listCheckpointRefs: (input: {
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly archivePaths: (input: {
      readonly cwd: string;
      readonly paths: ReadonlyArray<string>;
      readonly outputPath: string;
    }) => Effect.Effect<void, VcsError>;
    readonly extractArchive: (input: {
      readonly cwd: string;
      readonly archivePath: string;
    }) => Effect.Effect<void, VcsError | HandoffUntrackedCollisionError>;
    /** Points `origin` at the repository's real remote after a clone from a bundle. */
    readonly setOriginRemote: (input: {
      readonly cwd: string;
      readonly remoteUrl: string;
    }) => Effect.Effect<void, VcsError>;
    /** Path of the worktree that has `branch` checked out, if any. */
    readonly findWorktreeForBranch: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<string | null, VcsError>;
    /** Adds a detached worktree at `commit`; attaching a branch is a separate, fallible step. */
    readonly addWorktree: (input: {
      readonly cwd: string;
      readonly path: string;
      readonly commit: string;
    }) => Effect.Effect<void, VcsError>;
    /** Removes a worktree this hop created, so a failed apply leaves no stale checkout. */
    readonly removeWorktree: (input: {
      readonly cwd: string;
      readonly path: string;
    }) => Effect.Effect<void, VcsError>;
    /** True when `branch` is checked out by the repository or any worktree. */
    readonly isBranchCheckedOut: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<boolean, VcsError>;
    /** Restores a stash this hop created, used when an apply is rolled back. */
    readonly popStash: (input: {
      readonly cwd: string;
      readonly stashRef: string;
    }) => Effect.Effect<void, VcsError>;
  }
>()("t3/orchestration-v2/ThreadHandoffGit") {}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const git = (input: GitInput) => runGit(process, input);

  const resolveTip: ThreadHandoffGit["Service"]["resolveTip"] = (input) =>
    git({
      operation: "resolve-tip",
      args: ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((output) => {
        const tip = output.stdout.trim();
        if (output.exitCode === 0) return Effect.succeed(tip.length > 0 ? tip : null);
        // `rev-parse --verify --quiet` exits 1 with no diagnostics when the ref
        // simply does not exist. Anything that had something to say about
        // itself is a real failure and must not be read as "no branch": the
        // caller would classify the hop as `advance` and overwrite the branch.
        if (output.stderr.trim().length === 0) return Effect.succeed(null);
        return git({
          operation: "resolve-tip",
          args: ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
          cwd: input.cwd,
        }).pipe(Effect.as(null));
      }),
    );

  const resolveHead: ThreadHandoffGit["Service"]["resolveHead"] = (input) =>
    git({ operation: "resolve-head", args: ["rev-parse", "HEAD"], cwd: input.cwd }).pipe(
      Effect.map((output) => output.stdout.trim()),
    );

  const isAncestor: ThreadHandoffGit["Service"]["isAncestor"] = (input) =>
    git({
      operation: "is-ancestor",
      args: ["merge-base", "--is-ancestor", input.ancestor, input.descendant],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const hasCommonAncestor: ThreadHandoffGit["Service"]["hasCommonAncestor"] = (input) =>
    git({
      operation: "has-common-ancestor",
      args: ["merge-base", input.left, input.right],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0 && output.stdout.trim().length > 0));

  const hasCommit: ThreadHandoffGit["Service"]["hasCommit"] = (input) =>
    git({
      operation: "has-commit",
      args: ["cat-file", "-e", `${input.commit}^{commit}`],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const trackedPatch: ThreadHandoffGit["Service"]["trackedPatch"] = (input) =>
    git({
      operation: "tracked-patch",
      // --binary keeps images and other non-text changes intact; without it a
      // dirty png silently arrives as "Binary files differ" and never applies.
      args: ["diff", "--binary", "--no-color", "HEAD"],
      cwd: input.cwd,
      // The payload ceiling would refuse anything near this anyway; the cap is
      // here so an enormous binary diff fails before it is fully buffered.
      maxOutputBytes: PATCH_MAX_OUTPUT_BYTES,
    }).pipe(Effect.map((output) => output.stdout));

  const untrackedPaths: ThreadHandoffGit["Service"]["untrackedPaths"] = (input) =>
    git({
      operation: "untracked-paths",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd: input.cwd,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    }).pipe(Effect.map((output) => output.stdout.split("\0").filter((path) => path.length > 0)));

  const dirtyFileCount: ThreadHandoffGit["Service"]["dirtyFileCount"] = (input) =>
    git({
      operation: "dirty-file-count",
      args: ["status", "--porcelain", "-z"],
      cwd: input.cwd,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.map(
        (output) => output.stdout.split("\0").filter((entry) => entry.trim().length > 0).length,
      ),
    );

  const isPublished: ThreadHandoffGit["Service"]["isPublished"] = (input) =>
    git({
      operation: "is-published",
      args: ["branch", "--remotes", "--contains", input.commit],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0 && output.stdout.trim().length > 0));

  const tagCommit: ThreadHandoffGit["Service"]["tagCommit"] = (input) =>
    git({
      operation: "tag-commit",
      args: ["tag", "--force", input.tag, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const stashWorktree: ThreadHandoffGit["Service"]["stashWorktree"] = (input) =>
    Effect.gen(function* () {
      const dirty = yield* dirtyFileCount({ cwd: input.cwd });
      if (dirty === 0) return null;
      const stashRef = () =>
        git({
          operation: "stash-ref",
          args: ["rev-parse", "--verify", "--quiet", "refs/stash"],
          cwd: input.cwd,
          allowNonZeroExit: true,
        }).pipe(Effect.map((output) => output.stdout.trim()));
      // `git status` calls a repository with only submodule edits dirty, but
      // `stash push` does not stash them. Without comparing refs/stash before
      // and after, an older unrelated stash would be reported as this hop's.
      const before = yield* stashRef();
      yield* git({
        operation: "stash-worktree",
        args: ["stash", "push", "--include-untracked", "--message", input.label],
        cwd: input.cwd,
      });
      const after = yield* stashRef();
      return after.length > 0 && after !== before ? after : null;
    });

  const writeRef: ThreadHandoffGit["Service"]["writeRef"] = (input) =>
    git({
      operation: "write-ref",
      args: ["update-ref", input.ref, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const createBundle: ThreadHandoffGit["Service"]["createBundle"] = (input) =>
    Effect.gen(function* () {
      // A destination tip the sender has never seen (the ordinary diverged or
      // unrelated case) is not a resolvable revision here, and `--not <it>`
      // would fail the whole bundle. Dropping it only makes the bundle carry
      // more than strictly necessary.
      const resolvableTips = yield* Effect.filter(input.excludeTips, (tip) =>
        tip.startsWith("--")
          ? Effect.succeed(true)
          : git({
              operation: "check-exclude-tip",
              args: ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`],
              cwd: input.cwd,
              allowNonZeroExit: true,
            }).pipe(Effect.map((output) => output.exitCode === 0)),
      );
      const revListArgs = [
        ...input.refs,
        ...(resolvableTips.length === 0 ? [] : ["--not", ...resolvableTips]),
      ];
      // A branch whose every commit is already on the excluded tips — fully
      // pushed, the common case — would make `git bundle` refuse with "empty
      // bundle". That is a normal state, not a failure, so it is detected
      // first and reported as "nothing to bundle".
      const count = yield* git({
        operation: "count-bundle-commits",
        args: ["rev-list", "--count", ...revListArgs],
        cwd: input.cwd,
        timeoutMs: 600_000,
      });
      if (count.stdout.trim() === "0") return false;
      yield* git({
        operation: "create-bundle",
        args: ["bundle", "create", input.outputPath, ...revListArgs],
        cwd: input.cwd,
        // Bundling can walk a lot of history; the default probe timeout is
        // far too short for a real repository.
        timeoutMs: 600_000,
      });
      return true;
    });

  const importBundle: ThreadHandoffGit["Service"]["importBundle"] = (input) =>
    git({
      operation: "import-bundle",
      // Fetching from the bundle imports objects and names its refs without
      // moving any local branch, so classification happens before anything the
      // user can see changes.
      args: ["fetch", "--no-tags", input.bundlePath, "+refs/*:refs/handoff-incoming/*"],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const cloneFromBundle: ThreadHandoffGit["Service"]["cloneFromBundle"] = (input) =>
    git({
      operation: "clone-from-bundle",
      args: [
        "clone",
        ...(input.branch === null ? [] : ["--branch", input.branch]),
        input.bundlePath,
        input.targetPath,
      ],
      cwd: ".",
    }).pipe(Effect.asVoid);

  const applyPatch: ThreadHandoffGit["Service"]["applyPatch"] = (input) =>
    git({
      operation: input.check ? "apply-patch-check" : "apply-patch",
      // `--3way` implies `--index`, so everything arrives staged. The sender's
      // patch is a single `git diff HEAD` anyway: the staged/unstaged split
      // does not travel, and flattening it here is intentional.
      args: ["apply", "--3way", "--binary", ...(input.check ? ["--check"] : []), "-"],
      cwd: input.cwd,
      stdin: input.patch,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const checkoutBranchAt: ThreadHandoffGit["Service"]["checkoutBranchAt"] = (input) =>
    git({
      operation: "checkout-branch-at",
      args: ["checkout", "-B", input.branch, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const resetHardTo: ThreadHandoffGit["Service"]["resetHardTo"] = (input) =>
    git({
      operation: "reset-hard-to",
      args: ["reset", "--hard", input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const listCheckpointRefs: ThreadHandoffGit["Service"]["listCheckpointRefs"] = (input) =>
    git({
      operation: "list-checkpoint-refs",
      args: ["for-each-ref", "--format=%(refname)", "refs/t3code"],
      cwd: input.cwd,
      allowNonZeroExit: true,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.map((output) =>
        output.exitCode === 0
          ? output.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          : [],
      ),
    );

  const archivePaths: ThreadHandoffGit["Service"]["archivePaths"] = (input) =>
    // A null-delimited file list keeps paths containing spaces or newlines
    // intact, which is the form `git ls-files -z` already produces.
    process
      .run({
        operation: "thread-handoff.archive-paths",
        command: "tar",
        args: ["--null", "--files-from", "-", "-czf", input.outputPath],
        cwd: input.cwd,
        stdin: input.paths.length === 0 ? "" : `${input.paths.join("\0")}\0`,
      })
      .pipe(Effect.asVoid);

  const extractArchive: ThreadHandoffGit["Service"]["extractArchive"] = (input) =>
    Effect.gen(function* () {
      // A file untracked at the sender's tip can be tracked at the receiver's
      // descendant commit. Extracting over it would silently replace committed
      // content with the sender's stale untracked copy, so collisions with
      // tracked files refuse the hop the same way a patch conflict does.
      //
      // The check runs on real extracted paths, not on `tar -t` output: a
      // listing is newline-delimited, so a path embedding a newline would slip
      // past a listing-based check and overwrite exactly what it protects.
      const staging = `${input.archivePath}.staging`;
      // A retry reuses the archive path; leftovers from a previous failed
      // attempt would be swept into the worktree as if the archive held them.
      yield* process.run({
        operation: "thread-handoff.clear-staging",
        command: "rm",
        args: ["-rf", staging],
        cwd: input.cwd,
      });
      yield* process.run({
        operation: "thread-handoff.make-staging",
        command: "mkdir",
        args: ["-p", staging],
        cwd: input.cwd,
      });
      yield* process.run({
        operation: "thread-handoff.extract-archive",
        command: "tar",
        args: ["-xzf", input.archivePath, "-C", staging],
        cwd: input.cwd,
      });
      const extracted = yield* process
        .run({
          operation: "thread-handoff.list-extracted",
          command: "find",
          // Symlinks count: a sender symlink landing on a tracked regular
          // file would overwrite it just as thoroughly as a file would.
          args: [".", "(", "-type", "f", "-o", "-type", "l", ")", "-print0"],
          cwd: staging,
        })
        .pipe(
          Effect.map((output) =>
            output.stdout
              .split("\0")
              .map((entry) => entry.replace(/^\.\//, ""))
              .filter((entry) => entry.length > 0),
          ),
        );
      const tracked = yield* git({
        operation: "list-tracked",
        args: ["ls-files", "-z"],
        cwd: input.cwd,
      }).pipe(
        Effect.map((output) => new Set(output.stdout.split("\0").filter((p) => p.length > 0))),
      );
      const collisions = extracted.filter((entry) => tracked.has(entry));
      if (collisions.length > 0) {
        yield* process
          .run({
            operation: "thread-handoff.remove-staging",
            command: "rm",
            args: ["-rf", staging],
            cwd: input.cwd,
          })
          .pipe(Effect.ignore);
        return yield* new HandoffUntrackedCollisionError({
          cwd: input.cwd,
          collisions: collisions.slice(0, 5),
          collisionCount: collisions.length,
        });
      }
      // `cp -a staging/. cwd` moves the vetted tree in one step and copes with
      // dotfiles; the staging directory disappears afterwards either way.
      yield* process.run({
        operation: "thread-handoff.move-extracted",
        command: "cp",
        args: ["-a", `${staging}/.`, input.cwd],
        cwd: input.cwd,
      });
      yield* process
        .run({
          operation: "thread-handoff.remove-staging",
          command: "rm",
          args: ["-rf", staging],
          cwd: input.cwd,
        })
        .pipe(Effect.ignore);
    });

  const worktreeEntries = (input: { readonly cwd: string }) =>
    git({
      operation: "list-worktrees",
      args: ["worktree", "list", "--porcelain", "-z"],
      cwd: input.cwd,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.map((output) => {
        const entries: Array<{ path: string; branch: string | null }> = [];
        let current: { path: string; branch: string | null } | null = null;
        // `--porcelain -z` terminates every attribute with a NUL and separates
        // records with a second one, so splitting on NUL yields the attributes
        // plus empty strings between records.
        for (const line of output.stdout.split("\0")) {
          if (line.startsWith("worktree ")) {
            if (current !== null) entries.push(current);
            current = { path: line.slice("worktree ".length).trim(), branch: null };
          } else if (line.startsWith("branch ") && current !== null) {
            current.branch = line
              .slice("branch ".length)
              .trim()
              .replace(/^refs\/heads\//, "");
          }
        }
        if (current !== null) entries.push(current);
        return entries;
      }),
    );

  const findWorktreeForBranch: ThreadHandoffGit["Service"]["findWorktreeForBranch"] = (input) =>
    worktreeEntries(input).pipe(
      Effect.map((entries) => entries.find((entry) => entry.branch === input.branch)?.path ?? null),
    );

  const isBranchCheckedOut: ThreadHandoffGit["Service"]["isBranchCheckedOut"] = (input) =>
    worktreeEntries(input).pipe(
      Effect.map((entries) => entries.some((entry) => entry.branch === input.branch)),
    );

  const addWorktree: ThreadHandoffGit["Service"]["addWorktree"] = (input) =>
    git({
      operation: "add-worktree",
      args: ["worktree", "add", "--detach", input.path, input.commit],
      cwd: input.cwd,
      timeoutMs: 600_000,
    }).pipe(Effect.asVoid);

  const removeWorktree: ThreadHandoffGit["Service"]["removeWorktree"] = (input) =>
    git({
      operation: "remove-worktree",
      args: ["worktree", "remove", "--force", input.path],
      cwd: input.cwd,
      timeoutMs: 600_000,
    }).pipe(Effect.asVoid);

  const setOriginRemote: ThreadHandoffGit["Service"]["setOriginRemote"] = (input) =>
    git({
      operation: "set-origin-remote",
      // A clone from a bundle has the bundle file as its origin; replace it
      // with the real remote so fetch and push work afterwards.
      args: ["remote", "set-url", "origin", input.remoteUrl],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(
      Effect.flatMap((output) =>
        output.exitCode === 0
          ? Effect.void
          : git({
              operation: "add-origin-remote",
              args: ["remote", "add", "origin", input.remoteUrl],
              cwd: input.cwd,
            }).pipe(Effect.asVoid),
      ),
    );

  const popStash: ThreadHandoffGit["Service"]["popStash"] = (input) =>
    Effect.gen(function* () {
      // `stash pop` only takes a `stash@{n}` reflog entry, but what this hop
      // persisted is the stash commit's sha — the reflog index would go stale
      // the moment another stash lands. `stash apply` accepts the sha; the
      // drop then targets whichever reflog slot currently holds it.
      yield* git({
        operation: "apply-stash",
        args: ["stash", "apply", input.stashRef],
        cwd: input.cwd,
      });
      const reflog = yield* git({
        operation: "list-stashes",
        args: ["reflog", "stash", "--format=%H"],
        cwd: input.cwd,
        allowNonZeroExit: true,
      }).pipe(Effect.map((output) => output.stdout.split("\n").filter((sha) => sha.length > 0)));
      const index = reflog.indexOf(input.stashRef);
      if (index >= 0) {
        // The restore already happened; a failed drop only leaves a spare
        // stash entry behind, which is not worth failing the caller over.
        yield* git({
          operation: "drop-stash",
          args: ["stash", "drop", `stash@{${index}}`],
          cwd: input.cwd,
          allowNonZeroExit: true,
        });
      }
    });

  return {
    resolveTip,
    resolveHead,
    isAncestor,
    hasCommonAncestor,
    hasCommit,
    trackedPatch,
    untrackedPaths,
    dirtyFileCount,
    isPublished,
    tagCommit,
    stashWorktree,
    writeRef,
    createBundle,
    importBundle,
    cloneFromBundle,
    applyPatch,
    checkoutBranchAt,
    resetHardTo,
    listCheckpointRefs,
    archivePaths,
    extractArchive,
    popStash,
    setOriginRemote,
    findWorktreeForBranch,
    addWorktree,
    removeWorktree,
    isBranchCheckedOut,
  } satisfies ThreadHandoffGit["Service"];
});

export const layer: Layer.Layer<ThreadHandoffGit, never, VcsProcess.VcsProcess> = Layer.effect(
  ThreadHandoffGit,
  make,
);
