/**
 * GitSync - git primitives for project mirroring.
 *
 * Both sides of a mirror link speak the same protocol: capture the working
 * tree as a hook-free snapshot commit (the captureCheckpoint technique),
 * ship objects as git bundles, and transform a working tree from one
 * snapshot to another with a three-way merge. The host runs these against
 * the mirror directory; the origin's MirrorAgent runs them against the
 * user's real working copy.
 *
 * @module GitSync
 */
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { MirrorGitRemote } from "@t3tools/contracts";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";
import { MIRROR_INCLUDE_EXCLUDE_PATHSPECS } from "./mirrorInclude.ts";

export const MIRROR_SNAPSHOT_REF_PREFIX = "refs/t3/mirror/snapshots/";
/** Where host branches land on the origin when they cannot be fast-forwarded. */
export const MIRROR_INCOMING_BRANCH_REF_PREFIX = "refs/t3/mirror/branches/";

export const mirrorSnapshotRef = (syncId: string): string =>
  `${MIRROR_SNAPSHOT_REF_PREFIX}${syncId}`;

const GIT_TIMEOUT = "5 minutes";
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
} satisfies NodeJS.ProcessEnv;

export class GitSyncCommandError extends Schema.TaggedErrorClass<GitSyncCommandError>()(
  "GitSyncCommandError",
  {
    root: Schema.String,
    args: Schema.Array(Schema.String),
    exitCode: Schema.NullOr(Schema.Number),
    stderr: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    // `message` reaches MirrorSyncFailedError.detail and from there the RPC
    // boundary, status, and logs — so it must stay bounded. `args` and
    // `stderr` are kept as structured fields (e.g. for local debugging) but
    // never embedded here: args can carry a remote URL with embedded
    // credentials (setRemote/setRemotes), and stderr is unbounded raw
    // process output.
    const subcommand = this.args[0] ?? "git";
    return `git ${subcommand} failed in '${this.root}'${
      this.exitCode === null ? "" : ` with exit code ${this.exitCode}`
    }${this.stderr.trim().length > 0 ? ` (${this.stderr.trim().length} bytes of stderr)` : ""}`;
  }
}

export interface GitSnapshotResult {
  readonly snapshotOid: string;
  readonly treeOid: string;
}

export interface GitApplySnapshotResult {
  readonly outcome: "applied" | "conflicted";
  readonly conflictPaths: ReadonlyArray<string>;
  /** Snapshot of the local tree taken before anything was written. */
  readonly localSnapshotOid: string;
}

export class GitSync extends Context.Service<
  GitSync,
  {
    readonly isRepository: (root: string) => Effect.Effect<boolean, GitSyncCommandError>;
    readonly initRepository: (root: string) => Effect.Effect<void, GitSyncCommandError>;
    readonly headCommit: (root: string) => Effect.Effect<string | null, GitSyncCommandError>;
    readonly symbolicHead: (root: string) => Effect.Effect<string | null, GitSyncCommandError>;
    readonly listRemotes: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<MirrorGitRemote>, GitSyncCommandError>;
    readonly setRemotes: (
      root: string,
      remotes: ReadonlyArray<MirrorGitRemote>,
    ) => Effect.Effect<void, GitSyncCommandError>;
    readonly listRefs: (
      root: string,
      prefix: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly ref: string; readonly oid: string }>,
      GitSyncCommandError
    >;
    readonly listBranches: (
      root: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly ref: string; readonly oid: string }>,
      GitSyncCommandError
    >;
    readonly updateRef: (
      root: string,
      ref: string,
      oid: string | null,
    ) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Capture the working tree (tracked + untracked-unignored, plus the
     * force-included paths) as a parentless commit pinned under
     * refs/t3/mirror/snapshots/<syncId>. Never touches the real index.
     */
    readonly createSnapshot: (input: {
      readonly root: string;
      readonly syncId: string;
      readonly includePaths?: ReadonlyArray<string>;
    }) => Effect.Effect<GitSnapshotResult, GitSyncCommandError>;
    readonly treeOfCommit: (
      root: string,
      commitOid: string,
    ) => Effect.Effect<string | null, GitSyncCommandError>;
    /**
     * List gitlinks (mode 160000 tree entries — submodules and dangling
     * gitlinks alike; detection is `.gitmodules`-agnostic) reachable from
     * `treeOid`, recursing into ordinary subtrees but not into nested
     * repositories.
     */
    readonly listGitlinks: (
      root: string,
      treeOid: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly path: string; readonly oid: string }>,
      GitSyncCommandError
    >;
    /** Full-history bundle used for the initial seed, including the snapshot ref. */
    readonly createSeedBundle: (input: {
      readonly root: string;
      readonly bundlePath: string;
      readonly snapshotRef: string;
    }) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Incremental bundle: everything reachable from the snapshot ref and the
     * given refs but not from `baseOid`. The receiver must already have
     * `baseOid`.
     */
    readonly createIncrementalBundle: (input: {
      readonly root: string;
      readonly bundlePath: string;
      readonly baseOid: string;
      readonly snapshotRef: string;
      readonly includeBranches?: boolean;
    }) => Effect.Effect<void, GitSyncCommandError>;
    readonly fetchBundle: (input: {
      readonly root: string;
      readonly bundlePath: string;
      readonly refspecs: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Transform the working tree from its current state to `targetOid`,
     * three-way merged against `baseOid`. Conflicted paths keep the local
     * version and are reported; everything else lands. The local tree is
     * snapshotted first so no state is ever lost.
     */
    readonly applySnapshot: (input: {
      readonly root: string;
      readonly syncId: string;
      readonly baseOid: string;
      readonly targetOid: string;
      readonly includePaths?: ReadonlyArray<string>;
      /**
       * Which side wins a conflicted path. "local" (default) keeps this
       * machine's version — used on the origin so a user's edits are never
       * clobbered. "target" takes the incoming version — used on the host
       * where the origin's working copy is the source of truth.
       */
      readonly conflictPreference?: "local" | "target";
    }) => Effect.Effect<GitApplySnapshotResult, GitSyncCommandError>;
    /**
     * Refresh the real index from HEAD without touching the working tree
     * (mixed reset). Needed after moving the checked-out branch under a
     * worktree whose bytes were already synced.
     */
    readonly resetIndexToHead: (root: string) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Point a freshly seeded mirror at the origin's HEAD branch (or detach
     * onto the snapshot when the origin was detached) and hard-reset the
     * empty working tree to it. When the origin's branch is unborn, that
     * branch is started here at `fallbackOid`.
     */
    readonly checkoutSeedHead: (
      root: string,
      headRef: string | null,
      fallbackOid: string,
    ) => Effect.Effect<void, GitSyncCommandError>;
    /** Delete mirror snapshot refs except those whose oid is in `keepOids`. */
    readonly pruneSnapshotRefs: (input: {
      readonly root: string;
      readonly keepOids: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Update refs/heads/<name> on the receiving side when it is safe: the
     * branch is absent or an ancestor, and not checked out anywhere. Unsafe
     * updates are parked under refs/t3/mirror/branches/<name> instead.
     */
    readonly applyBranchUpdates: (input: {
      readonly root: string;
      readonly refUpdates: ReadonlyArray<{ readonly ref: string; readonly oid: string }>;
    }) => Effect.Effect<void, GitSyncCommandError>;
    /**
     * Fast-forward the CHECKED-OUT branch after the working tree was already
     * synced to the target state, then mixed-reset so the index agrees.
     * Diverged branches are parked like applyBranchUpdates would.
     */
    readonly applyBranchUpdatesToCurrent: (input: {
      readonly root: string;
      readonly ref: string;
      readonly oid: string;
    }) => Effect.Effect<void, GitSyncCommandError>;
  }
>()("t3/mirror/GitSync") {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run = (input: {
    readonly root: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
  }) =>
    runner
      .run({
        command: "git",
        args: input.args,
        cwd: input.root,
        timeout: GIT_TIMEOUT,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        ...(input.env === undefined ? {} : { env: input.env }),
      })
      .pipe(
        Effect.mapError(
          (cause: ProcessRunError) =>
            new GitSyncCommandError({
              root: input.root,
              args: input.args,
              exitCode: null,
              stderr: "",
              cause,
            }),
        ),
        Effect.flatMap((result) =>
          result.code === 0 || input.allowNonZeroExit === true
            ? Effect.succeed(result)
            : Effect.fail(
                new GitSyncCommandError({
                  root: input.root,
                  args: input.args,
                  exitCode: typeof result.code === "number" ? result.code : null,
                  stderr: result.stderr,
                }),
              ),
        ),
      );

  const resolveGitCommonDir = Effect.fn("GitSync.resolveGitCommonDir")(function* (root: string) {
    const result = yield* run({ root, args: ["rev-parse", "--git-common-dir"] });
    const gitCommonDir = result.stdout.trim();
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(root, gitCommonDir);
  });

  const headCommit: GitSync["Service"]["headCommit"] = Effect.fn("GitSync.headCommit")(
    function* (root) {
      const result = yield* run({
        root,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      });
      if (result.code !== 0) return null;
      const oid = result.stdout.trim();
      return oid.length > 0 ? oid : null;
    },
  );

  /** Run a series of git commands against a throwaway index seeded from `seedTree`. */
  const withTempIndex = <A, E>(
    root: string,
    use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const gitCommonDir = yield* resolveGitCommonDir(root);
      const tempIndexPath = path.join(gitCommonDir, `t3-mirror-index-${NodeCrypto.randomUUID()}`);
      const env: NodeJS.ProcessEnv = {
        ...SNAPSHOT_ENV,
        GIT_INDEX_FILE: tempIndexPath,
      };
      return yield* use(env).pipe(
        Effect.ensuring(fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore)),
      );
    });

  const createSnapshot: GitSync["Service"]["createSnapshot"] = Effect.fn("GitSync.createSnapshot")(
    function* (input) {
      return yield* withTempIndex(input.root, (env) =>
        Effect.gen(function* () {
          const head = yield* headCommit(input.root);
          if (head !== null) {
            yield* run({ root: input.root, args: ["read-tree", "HEAD"], env });
          }
          yield* run({ root: input.root, args: ["add", "-A", "--", "."], env });
          if (input.includePaths !== undefined && input.includePaths.length > 0) {
            // Force-add the include allowlist (.env and friends), one path
            // per invocation: `git add` is fatal on an unmatched pathspec and
            // then adds NONE of its arguments, so a single missing entry in a
            // combined call would silently drop the paths that do exist.
            // Dependency trees are never synced, so matches under any
            // node_modules are excluded from every add.
            for (const includePath of input.includePaths) {
              yield* run({
                root: input.root,
                args: [
                  "add",
                  "-f",
                  "--ignore-errors",
                  "--",
                  includePath,
                  ...MIRROR_INCLUDE_EXCLUDE_PATHSPECS,
                ],
                env,
                allowNonZeroExit: true,
              });
            }
          }
          const writeTree = yield* run({ root: input.root, args: ["write-tree"], env });
          const treeOid = writeTree.stdout.trim();
          if (treeOid.length === 0) {
            return yield* new GitSyncCommandError({
              root: input.root,
              args: ["write-tree"],
              exitCode: 0,
              stderr: "git write-tree returned an empty tree oid.",
            });
          }
          const commitTree = yield* run({
            root: input.root,
            args: ["commit-tree", treeOid, "-m", `t3 mirror snapshot sync=${input.syncId}`],
            env,
          });
          const snapshotOid = commitTree.stdout.trim();
          if (snapshotOid.length === 0) {
            return yield* new GitSyncCommandError({
              root: input.root,
              args: ["commit-tree"],
              exitCode: 0,
              stderr: "git commit-tree returned an empty commit oid.",
            });
          }
          yield* run({
            root: input.root,
            args: ["update-ref", mirrorSnapshotRef(input.syncId), snapshotOid],
          });
          return { snapshotOid, treeOid } satisfies GitSnapshotResult;
        }),
      );
    },
  );

  const treeOfCommit: GitSync["Service"]["treeOfCommit"] = Effect.fn("GitSync.treeOfCommit")(
    function* (root, commitOid) {
      const result = yield* run({
        root,
        args: ["rev-parse", "--verify", "--quiet", `${commitOid}^{tree}`],
        allowNonZeroExit: true,
      });
      if (result.code !== 0) return null;
      const oid = result.stdout.trim();
      return oid.length > 0 ? oid : null;
    },
  );

  /**
   * Materialize the transition localTree -> targetTree in the working tree.
   * The temp index is seeded with localTree (which the working tree matches,
   * because localTree was just snapshotted from it), then a one-tree reset
   * read-tree updates, creates, and deletes exactly the paths that differ.
   * `--reset` is deliberate: a freshly read index has no stat data, so the
   * `-m` up-to-date guard would refuse every entry; the local state it would
   * be guarding is already preserved in the snapshot commit.
   */
  const transformWorktree = (root: string, localTreeOid: string, targetTreeOid: string) =>
    withTempIndex(root, (env) =>
      Effect.gen(function* () {
        yield* run({ root, args: ["read-tree", localTreeOid], env });
        yield* run({
          root,
          args: ["read-tree", "--reset", "-u", targetTreeOid],
          env,
        });
      }),
    );

  const applySnapshot: GitSync["Service"]["applySnapshot"] = Effect.fn("GitSync.applySnapshot")(
    function* (input) {
      const local = yield* createSnapshot({
        root: input.root,
        syncId: `${input.syncId}-local`,
        ...(input.includePaths === undefined ? {} : { includePaths: input.includePaths }),
      });
      const baseTree = yield* treeOfCommit(input.root, input.baseOid);
      const targetTree = yield* treeOfCommit(input.root, input.targetOid);
      if (targetTree === null) {
        return yield* new GitSyncCommandError({
          root: input.root,
          args: ["rev-parse", `${input.targetOid}^{tree}`],
          exitCode: null,
          stderr: `Target snapshot ${input.targetOid} is not present in this repository.`,
        });
      }

      // Fast path: local tree unchanged since the shared base; take the
      // target tree wholesale.
      if (baseTree !== null && local.treeOid === baseTree) {
        yield* transformWorktree(input.root, local.treeOid, targetTree);
        return {
          outcome: "applied",
          conflictPaths: [],
          localSnapshotOid: local.snapshotOid,
        } satisfies GitApplySnapshotResult;
      }

      const merge = yield* run({
        root: input.root,
        args: [
          "merge-tree",
          "--write-tree",
          "--no-messages",
          "--name-only",
          // NUL-terminated, unquoted paths: without -z, git escapes paths
          // with tabs/newlines/quotes/backslashes/non-ASCII bytes, and the
          // conflict list below must be the real on-disk path since it's
          // used to look the entry up again with ls-tree.
          "-z",
          `--merge-base=${input.baseOid}`,
          local.snapshotOid,
          input.targetOid,
        ],
        allowNonZeroExit: true,
      });
      // Exit 0: clean merge. Exit 1: conflicts, first line is still the
      // written tree. Anything else is a real failure.
      if (merge.code !== 0 && merge.code !== 1) {
        return yield* new GitSyncCommandError({
          root: input.root,
          args: ["merge-tree", "--write-tree"],
          exitCode: typeof merge.code === "number" ? merge.code : null,
          stderr: merge.stderr,
        });
      }
      const lines = merge.stdout.split("\0").filter((line) => line.length > 0);
      const mergedTree = lines[0]?.trim() ?? "";
      if (mergedTree.length === 0) {
        return yield* new GitSyncCommandError({
          root: input.root,
          args: ["merge-tree", "--write-tree"],
          exitCode: typeof merge.code === "number" ? merge.code : null,
          stderr: "git merge-tree returned no tree oid.",
        });
      }
      const conflictPaths = merge.code === 1 ? [...new Set(lines.slice(1))] : [];

      let finalTree = mergedTree;
      if (conflictPaths.length > 0) {
        // The merged tree contains conflict markers, which must never be
        // written to a working tree. Replace each conflicted path with the
        // preferred side's version instead.
        const preferredCommit =
          input.conflictPreference === "target" ? input.targetOid : local.snapshotOid;
        finalTree = yield* withTempIndex(input.root, (env) =>
          Effect.gen(function* () {
            yield* run({ root: input.root, args: ["read-tree", mergedTree], env });
            const indexInfoLines: string[] = [];
            for (const conflictPath of conflictPaths) {
              const lsTree = yield* run({
                root: input.root,
                args: ["ls-tree", preferredCommit, "--", conflictPath],
              });
              const entry = lsTree.stdout.trim();
              if (entry.length === 0) {
                // Deleted locally: drop it from the final tree too. The zero
                // OID width must match the repo's hash algorithm (64 hex
                // chars for SHA-256, not just SHA-1's 40) — mergedTree is a
                // real oid from this same repo, so its length is authoritative.
                indexInfoLines.push(`000000 ${"0".repeat(mergedTree.length)}\t${conflictPath}`);
              } else {
                // Matches both plain blobs and submodule gitlinks (mode
                // 160000, type commit) — a conflicted gitlink otherwise
                // produces no update-index instruction and keeps
                // merge-tree's synthetic result instead of either side's
                // real submodule pointer.
                const match = entry.match(/^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t/);
                if (match?.[1] !== undefined && match[2] !== undefined) {
                  indexInfoLines.push(`${match[1]} ${match[2]}\t${conflictPath}`);
                }
              }
            }
            if (indexInfoLines.length > 0) {
              const updateIndex = yield* runner
                .run({
                  command: "git",
                  args: ["update-index", "--index-info"],
                  cwd: input.root,
                  env,
                  stdin: `${indexInfoLines.join("\n")}\n`,
                  timeout: GIT_TIMEOUT,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitSyncCommandError({
                        root: input.root,
                        args: ["update-index", "--index-info"],
                        exitCode: null,
                        stderr: "",
                        cause,
                      }),
                  ),
                );
              if (updateIndex.code !== 0) {
                return yield* new GitSyncCommandError({
                  root: input.root,
                  args: ["update-index", "--index-info"],
                  exitCode: typeof updateIndex.code === "number" ? updateIndex.code : null,
                  stderr: updateIndex.stderr,
                });
              }
            }
            const writeTree = yield* run({ root: input.root, args: ["write-tree"], env });
            return writeTree.stdout.trim();
          }),
        );
      }

      yield* transformWorktree(input.root, local.treeOid, finalTree);
      return {
        outcome: conflictPaths.length > 0 ? "conflicted" : "applied",
        conflictPaths,
        localSnapshotOid: local.snapshotOid,
      } satisfies GitApplySnapshotResult;
    },
  );

  const listGitlinks: GitSync["Service"]["listGitlinks"] = Effect.fn("GitSync.listGitlinks")(
    function* (root, treeOid) {
      // `-z` disables git's pathname quoting (tabs, newlines, quotes,
      // backslashes, non-ASCII bytes), so entries are NUL-terminated instead
      // of newline-terminated and the path is the real on-disk path rather
      // than an escaped display form.
      const result = yield* run({ root, args: ["ls-tree", "-r", "-z", treeOid] });
      const gitlinks: Array<{ path: string; oid: string }> = [];
      for (const entry of result.stdout.split("\0")) {
        if (entry.length === 0) continue;
        const match = entry.match(/^160000 commit ([0-9a-f]+)\t(.+)$/);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          gitlinks.push({ path: match[2], oid: match[1] });
        }
      }
      return gitlinks;
    },
  );

  const isRepository: GitSync["Service"]["isRepository"] = Effect.fn("GitSync.isRepository")(
    function* (root) {
      const stat = yield* fileSystem.stat(root).pipe(Effect.option);
      if (stat._tag === "None" || stat.value.type !== "Directory") return false;
      // `--is-inside-work-tree` alone is not enough: a directory that sits
      // inside an *enclosing* repository's work tree (e.g. an unmaterialized
      // submodule/gitlink path that was never `git init`'d on its own)
      // already reports "true" there, even though `root` itself is not a
      // repository. A `.git` entry (a directory for a normal repo, or a file
      // for a submodule/worktree gitlink) must exist directly at `root`.
      const gitEntry = yield* fileSystem.stat(path.join(root, ".git")).pipe(Effect.option);
      if (gitEntry._tag === "None") return false;
      const result = yield* run({
        root,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      });
      return result.code === 0 && result.stdout.trim() === "true";
    },
  );

  const initRepository: GitSync["Service"]["initRepository"] = Effect.fn("GitSync.initRepository")(
    function* (root) {
      yield* run({ root, args: ["init"] });
      // Cross-OS fidelity: bytes in the mirror are exactly the origin's bytes.
      yield* run({ root, args: ["config", "core.autocrlf", "false"] });
    },
  );

  const symbolicHead: GitSync["Service"]["symbolicHead"] = Effect.fn("GitSync.symbolicHead")(
    function* (root) {
      const result = yield* run({
        root,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      });
      if (result.code !== 0) return null;
      const ref = result.stdout.trim();
      return ref.length > 0 ? ref : null;
    },
  );

  const listRemotes: GitSync["Service"]["listRemotes"] = Effect.fn("GitSync.listRemotes")(
    function* (root) {
      const result = yield* run({ root, args: ["remote", "-v"] });
      const remotes = new Map<string, string>();
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/^(\S+)\t(\S+) \(fetch\)$/);
        if (match?.[1] !== undefined && match[2] !== undefined && !remotes.has(match[1])) {
          remotes.set(match[1], match[2]);
        }
      }
      return Array.from(remotes, ([name, url]) => ({ name, url }));
    },
  );

  const setRemotes: GitSync["Service"]["setRemotes"] = Effect.fn("GitSync.setRemotes")(
    function* (root, remotes) {
      const existing = yield* listRemotes(root);
      const existingNames = new Set(existing.map((remote) => remote.name));
      for (const remote of remotes) {
        yield* run({
          root,
          args: existingNames.has(remote.name)
            ? ["remote", "set-url", remote.name, remote.url]
            : ["remote", "add", remote.name, remote.url],
        });
      }
    },
  );

  const listRefs: GitSync["Service"]["listRefs"] = Effect.fn("GitSync.listRefs")(
    function* (root, prefix) {
      const result = yield* run({
        root,
        args: ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
      });
      const refs: Array<{ ref: string; oid: string }> = [];
      for (const line of result.stdout.split("\n")) {
        const [ref, oid] = line.trim().split(" ");
        if (ref !== undefined && oid !== undefined && ref.length > 0 && oid.length > 0) {
          refs.push({ ref, oid });
        }
      }
      return refs;
    },
  );

  const listBranches: GitSync["Service"]["listBranches"] = (root) => listRefs(root, "refs/heads");

  const updateRef: GitSync["Service"]["updateRef"] = Effect.fn("GitSync.updateRef")(
    function* (root, ref, oid) {
      yield* run({
        root,
        args: oid === null ? ["update-ref", "-d", ref] : ["update-ref", ref, oid],
        allowNonZeroExit: oid === null,
      });
    },
  );

  const createSeedBundle: GitSync["Service"]["createSeedBundle"] = Effect.fn(
    "GitSync.createSeedBundle",
  )(function* (input) {
    // An origin folder we just initialized has an unborn HEAD and no branches.
    // Naming HEAD there fails the whole bundle ("ambiguous argument 'HEAD'"),
    // and --branches matches nothing, so the snapshot ref carries the working
    // tree on its own.
    const head = yield* headCommit(input.root);
    yield* run({
      root: input.root,
      args: [
        "bundle",
        "create",
        input.bundlePath,
        "--branches",
        ...(head === null ? [] : ["HEAD"]),
        input.snapshotRef,
      ],
    });
  });

  const createIncrementalBundle: GitSync["Service"]["createIncrementalBundle"] = Effect.fn(
    "GitSync.createIncrementalBundle",
  )(function* (input) {
    yield* run({
      root: input.root,
      args: [
        "bundle",
        "create",
        input.bundlePath,
        input.snapshotRef,
        ...(input.includeBranches === true ? ["--branches"] : []),
        "--not",
        input.baseOid,
      ],
    });
  });

  const fetchBundle: GitSync["Service"]["fetchBundle"] = Effect.fn("GitSync.fetchBundle")(
    function* (input) {
      yield* run({
        root: input.root,
        args: ["bundle", "verify", "--quiet", input.bundlePath],
      });
      yield* run({
        root: input.root,
        args: [
          "fetch",
          "--no-tags",
          "--force",
          // Gitlinks are mirrored through this module's own directives, not
          // git's submodule machinery. Once a gitlink path has a real nested
          // repository (registered in .gitmodules or not), a plain fetch can
          // otherwise trigger git's own submodule recursion against remotes
          // this protocol never configured, which fails the whole fetch.
          "--recurse-submodules=no",
          input.bundlePath,
          ...input.refspecs,
        ],
      });
    },
  );

  const resetIndexToHead: GitSync["Service"]["resetIndexToHead"] = Effect.fn(
    "GitSync.resetIndexToHead",
  )(function* (root) {
    yield* run({ root, args: ["reset", "--quiet"] });
  });

  const checkoutSeedHead: GitSync["Service"]["checkoutSeedHead"] = Effect.fn(
    "GitSync.checkoutSeedHead",
  )(function* (root, headRef, fallbackOid) {
    if (headRef !== null) {
      const exists = yield* run({
        root,
        args: ["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`],
        allowNonZeroExit: true,
      });
      if (exists.code === 0) {
        yield* run({ root, args: ["symbolic-ref", "HEAD", headRef] });
        yield* run({ root, args: ["reset", "--hard", "--quiet"] });
        return;
      }
      // The origin named a branch the seed bundle did not carry, which means
      // the origin's branch is unborn (a folder we just initialized). Start
      // that branch here at the snapshot so the mirror runs on a real branch
      // under the same name instead of a detached HEAD.
      yield* run({ root, args: ["update-ref", headRef, fallbackOid] });
      yield* run({ root, args: ["symbolic-ref", "HEAD", headRef] });
      yield* run({ root, args: ["reset", "--hard", "--quiet"] });
      return;
    }
    yield* run({ root, args: ["update-ref", "--no-deref", "HEAD", fallbackOid] });
    yield* run({ root, args: ["reset", "--hard", "--quiet"] });
  });

  const pruneSnapshotRefs: GitSync["Service"]["pruneSnapshotRefs"] = Effect.fn(
    "GitSync.pruneSnapshotRefs",
  )(function* (input) {
    const keep = new Set(input.keepOids);
    const result = yield* run({
      root: input.root,
      args: [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        MIRROR_SNAPSHOT_REF_PREFIX.slice(0, -1),
      ],
    });
    for (const line of result.stdout.split("\n")) {
      const [ref, oid] = line.trim().split(" ");
      if (ref !== undefined && oid !== undefined && ref.length > 0 && !keep.has(oid)) {
        yield* run({ root: input.root, args: ["update-ref", "-d", ref], allowNonZeroExit: true });
      }
    }
  });

  const applyBranchUpdates: GitSync["Service"]["applyBranchUpdates"] = Effect.fn(
    "GitSync.applyBranchUpdates",
  )(function* (input) {
    if (input.refUpdates.length === 0) return;
    const currentBranch = yield* symbolicHead(input.root);
    // Branches checked out in any linked worktree can never be moved.
    const worktreeHeads = yield* run({
      root: input.root,
      args: ["worktree", "list", "--porcelain"],
      allowNonZeroExit: true,
    });
    const checkedOut = new Set<string>();
    if (currentBranch !== null) checkedOut.add(currentBranch);
    for (const line of worktreeHeads.stdout.split("\n")) {
      if (line.startsWith("branch ")) checkedOut.add(line.slice("branch ".length).trim());
    }
    for (const update of input.refUpdates) {
      if (!update.ref.startsWith("refs/heads/")) continue;
      const branchName = update.ref.slice("refs/heads/".length);
      const parkedRef = `${MIRROR_INCOMING_BRANCH_REF_PREFIX}${branchName}`;
      if (checkedOut.has(update.ref)) {
        yield* run({ root: input.root, args: ["update-ref", parkedRef, update.oid] });
        continue;
      }
      const existing = yield* run({
        root: input.root,
        args: ["rev-parse", "--verify", "--quiet", `${update.ref}^{commit}`],
        allowNonZeroExit: true,
      });
      const existingOid = existing.code === 0 ? existing.stdout.trim() : null;
      if (existingOid === null) {
        yield* run({ root: input.root, args: ["update-ref", update.ref, update.oid] });
        continue;
      }
      if (existingOid === update.oid) continue;
      const isAncestor = yield* run({
        root: input.root,
        args: ["merge-base", "--is-ancestor", existingOid, update.oid],
        allowNonZeroExit: true,
      });
      if (isAncestor.code === 0) {
        yield* run({
          root: input.root,
          args: ["update-ref", update.ref, update.oid, existingOid],
        });
      } else {
        // Diverged locally: park the host's version instead of clobbering.
        yield* run({ root: input.root, args: ["update-ref", parkedRef, update.oid] });
      }
    }
  });

  const applyBranchUpdatesToCurrent: GitSync["Service"]["applyBranchUpdatesToCurrent"] = Effect.fn(
    "GitSync.applyBranchUpdatesToCurrent",
  )(function* (input) {
    const existing = yield* run({
      root: input.root,
      args: ["rev-parse", "--verify", "--quiet", `${input.ref}^{commit}`],
      allowNonZeroExit: true,
    });
    const existingOid = existing.code === 0 ? existing.stdout.trim() : null;
    if (existingOid === input.oid) return;
    const branchName = input.ref.startsWith("refs/heads/")
      ? input.ref.slice("refs/heads/".length)
      : input.ref;
    if (existingOid !== null) {
      const isAncestor = yield* run({
        root: input.root,
        args: ["merge-base", "--is-ancestor", existingOid, input.oid],
        allowNonZeroExit: true,
      });
      if (isAncestor.code !== 0) {
        yield* run({
          root: input.root,
          args: ["update-ref", `${MIRROR_INCOMING_BRANCH_REF_PREFIX}${branchName}`, input.oid],
        });
        return;
      }
    }
    yield* run({
      root: input.root,
      args:
        existingOid === null
          ? ["update-ref", input.ref, input.oid]
          : ["update-ref", input.ref, input.oid, existingOid],
    });
    yield* run({ root: input.root, args: ["reset", "--quiet"] });
  });

  return GitSync.of({
    isRepository,
    initRepository,
    headCommit,
    symbolicHead,
    listRemotes,
    setRemotes,
    listRefs,
    listBranches,
    updateRef,
    createSnapshot,
    treeOfCommit,
    listGitlinks,
    createSeedBundle,
    createIncrementalBundle,
    fetchBundle,
    applySnapshot,
    resetIndexToHead,
    checkoutSeedHead,
    pruneSnapshotRefs,
    applyBranchUpdates,
    applyBranchUpdatesToCurrent,
  });
});

export const layer = Layer.effect(GitSync, make);
