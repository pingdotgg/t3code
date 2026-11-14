import * as NodeBuffer from "node:buffer";
import { CHECKPOINT_RECOVERY_MAX_CANDIDATES, CHECKPOINT_RECOVERY_TIMEOUT, FLAGGED_INDEX_ENTRIES_MAX_BYTES, GitVcsDriver, WORKSPACE_FILES_MAX_OUTPUT_BYTES } from "./GitVcsDriver.ts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  GitCommandError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

import type { makeGitVcsState } from "./GitVcsDriver-part3.ts";

type State = Effect.Success<ReturnType<typeof makeGitVcsState>>;

export const makeGitVcsFlows = Effect.fn("makeGitVcsFlows")(function* (state: State) {
  const {
    fileSystem,
    path,
    vcsProcess,
    random,
    hostPlatform,
    isInsideWorkTree,
    execute,
    detectRepository,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    resolveHeadCommit,
    hasHeadCommit,
    resolveCheckpointCommit,
    resolveGitCommonDir,
    resolveCaptureRepository,
    durableWrite,
    longPaths,
  } = state;
  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      // Scratch split-index writes can expire sharedindex files still used by the real index.
      const indexConfig = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "sparse.expectFilesOutsideOfPatterns=false",
        "-c",
        "core.splitIndex=false",
        "-c",
        "splitIndex.sharedIndexExpire=never",
      ];
      const { gitCommonDir, indexPath, headExists } = yield* resolveCaptureRepository(input.cwd);
      const indexId = yield* random.uuidV4();
      const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${indexId}`);
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
      };

      const cleanupTempIndex = Effect.forEach(
        [tempIndexPath, `${tempIndexPath}.lock`],
        (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
        { discard: true },
      );

      yield* Effect.gen(function* () {
        const sparseConfig = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["config", "--bool", "core.sparseCheckout"],
          allowNonZeroExit: true,
        });
        let sparseCheckout = sparseConfig.stdout.trim() === "true";
        if (sparseCheckout) {
          const help = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["add", "-h"],
            allowNonZeroExit: true,
          });
          sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
        }
        if (headExists) {
          const reusedIndex = yield* Effect.gen(function* () {
            const userIndexPath =
              indexPath ??
              (yield* execute({
                operation,
                cwd: input.cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
              })).stdout.trim();
            const { mtime } = yield* fileSystem.stat(userIndexPath);
            if (Option.isNone(mtime)) return false;
            // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
            const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
            if (indexTime <= 0) return false;
            yield* fileSystem.copyFile(userIndexPath, tempIndexPath);
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "read-tree", "--reset", "HEAD"],
              env: commitEnv,
            });
            // read-tree can rewrite the index, so restore its racy timestamp afterward.
            yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            // Manually flagged entries hide edits from add -A, so they are re-added below
            // with no stat cache. Every other entry keeps its stat data and is not rehashed.
            let fallback = false;
            let flaggedBytes = 0;
            let recordStart = true;
            let collect: "flagged" | "skipped" | undefined;
            let record: Uint8Array[] = [];
            const flagged: string[] = [];
            const skipped: string[] = [];
            yield* vcsProcess.run({
              operation,
              command: "git",
              cwd: input.cwd,
              args: [...indexConfig, "ls-files", "--full-name", "--sparse", "--stage", "-v", "-z"],
              env: commitEnv,
              maxOutputBytes: 4_096,
              outputMode: "truncate",
              // Only tags and flagged or skip-worktree records matter; scan NUL-delimited records.
              onStdoutChunk: (chunk) => {
                let start = 0;
                while (start < chunk.length && !fallback) {
                  const end = chunk.indexOf(0, start);
                  if (recordStart) {
                    const tag = chunk[start]!;
                    record = [];
                    // Sparse skip-worktree bits are expected; only in-cone ones are manual.
                    collect =
                      tag === 83 && sparseCheckout
                        ? "skipped"
                        : (tag >= 97 && tag <= 122) || tag === 83
                          ? "flagged"
                          : undefined;
                    // index-info cannot keep skip-worktree while dropping assume-unchanged.
                    if (tag === 115 && sparseCheckout) fallback = true;
                  }
                  if (collect !== undefined && !fallback) {
                    const piece = chunk.subarray(start, end === -1 ? undefined : end);
                    record.push(Buffer.from(piece));
                    if (
                      collect === "flagged" &&
                      (flaggedBytes += piece.length) > FLAGGED_INDEX_ENTRIES_MAX_BYTES
                    )
                      fallback = true;
                    if (end !== -1 && !fallback) {
                      const full = Buffer.concat(record);
                      record = [];
                      // Sparse directory entries stay collapsed.
                      if (collect === "flagged" || full.at(-1) !== 47) {
                        // Drop the "<tag> " prefix, leaving index-info's "<mode> <oid> <stage>\t<path>".
                        const entry = full.subarray(2);
                        if (!NodeBuffer.isUtf8(entry)) fallback = true;
                        else
                          (collect === "flagged" ? flagged : skipped).push(entry.toString("utf8"));
                      }
                    }
                  }
                  recordStart = end !== -1;
                  if (!recordStart) break;
                  start = end + 1;
                }
              },
            });
            if (fallback) return false;
            if (skipped.length > 0) {
              const paths = skipped.map((entry) => entry.slice(entry.indexOf("\t") + 1));
              const stdin = paths.join("\0") + "\0";
              // check-rules echoes a subset of its input, so the input size bounds its output.
              const rules = yield* execute({
                operation,
                cwd: input.cwd,
                args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                stdin,
                env: commitEnv,
                maxOutputBytes: Buffer.byteLength(stdin),
                outputMode: "error",
              });
              const selected = new Set(rules.stdout.split("\0"));
              skipped.forEach((entry, index) => {
                if (selected.has(paths[index]!)) flagged.push(entry);
              });
            }
            if (flagged.length > 0) {
              // Flagged gitlinks keep the fresh-index behaviour rather than a guessed one.
              if (flagged.some((entry) => entry.startsWith("160000 "))) return false;
              yield* execute({
                operation,
                cwd: input.cwd,
                // core.ignorestat would mark these assume-unchanged, hiding edits from add -A.
                args: [
                  ...indexConfig,
                  "-c",
                  "core.ignorestat=false",
                  "update-index",
                  "-z",
                  "--index-info",
                ],
                stdin: flagged.join("\0") + "\0",
                env: commitEnv,
              });
              yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            }
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!reusedIndex) {
            if (sparseCheckout) {
              const cone = yield* execute({
                operation,
                cwd: input.cwd,
                args: ["config", "--bool", "core.sparseCheckoutCone"],
                allowNonZeroExit: true,
              });
              // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
              if (cone.stdout.trim() !== "true") {
                return yield* new VcsProcessExitError({
                  operation,
                  command: "git read-tree",
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                });
              }
            }
            yield* cleanupTempIndex;
            yield* execute({
              operation,
              cwd: input.cwd,
              args: sparseCheckout
                ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                : [...indexConfig, "read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        const workspaceIgnored = (yield* filterIgnoredPaths(input.cwd, ["."])).length === 0;
        if (workspaceIgnored) {
          // HEAD omits staged-only paths. Seed just this workspace's additions, keeping
          // unrelated staged changes and the scratch index's sparse flags untouched.
          const additions = yield* execute({
            operation,
            cwd: input.cwd,
            args: [
              "-c",
              "core.quotePath=true",
              "diff",
              "--cached",
              "--raw",
              "--no-abbrev",
              "--no-renames",
              "--no-relative",
              "--ignore-submodules=none",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--ita-visible-in-index",
              "--diff-filter=A",
              "--",
              ".",
            ],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
          if (additions.stdout.length > 0) {
            // Git's quoted paths round-trip through index-info, including non-UTF-8 names.
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "-c", "index.sparse=false", "update-index", "--index-info"],
              stdin: additions.stdout.replace(
                /^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A\t/gm,
                "$1 $2\t",
              ),
              env: commitEnv,
            });
          }
          const tracked = yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "ls-files", "--cached", "-z", "--", "."],
            env: commitEnv,
            maxOutputBytes: 1,
            outputMode: "truncate",
          });
          if (tracked.stdout.length === 0) {
            return yield* new VcsUnsupportedOperationError({
              operation,
              kind: "git",
              detail: "The workspace directory is ignored by its Git repository.",
            });
          }
        }

        const stageFiles = (exclusions: ReadonlyArray<string>) =>
          execute({
            operation,
            cwd: input.cwd,
            args: [
              ...indexConfig,
              ...durableWrite,
              ...longPaths,
              // safecrlf=true refuses LF files under CRLF conversion; capture them as Git's default does.
              "-c",
              "core.safecrlf=false",
              "add",
              ...(sparseCheckout ? ["--sparse"] : []),
              // add -A rejects ignored directories even when they contain tracked files.
              workspaceIgnored ? "-u" : "-A",
              "--",
              ".",
              ...exclusions,
            ],
            env: commitEnv,
          });
        yield* stageFiles([]).pipe(
          Effect.catchTags({
            VcsProcessExitError: (error) =>
              Effect.gen(function* () {
                // Git cannot stage uncommitted embedded repos; scan for them only after staging fails.
                const untracked = yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [
                    ...longPaths,
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                  ],
                  env: commitEnv,
                  maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                });
                if (untracked.stdoutTruncated) return yield* error;
                const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                  entry.endsWith("/"),
                );
                if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                const nestedRepoEnv: NodeJS.ProcessEnv = {
                  ...process.env,
                  GIT_DIR: undefined,
                  GIT_WORK_TREE: undefined,
                  GIT_COMMON_DIR: undefined,
                  GIT_INDEX_FILE: undefined,
                  GIT_OBJECT_DIRECTORY: undefined,
                  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                };
                const exclusions: Array<string> = [];
                for (const entry of candidates) {
                  const nestedCwd = path.join(input.cwd, entry);
                  if (
                    (yield* fileSystem
                      .exists(path.join(nestedCwd, ".git"))
                      .pipe(Effect.mapError(() => error))) &&
                    !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                  ) {
                    exclusions.push(`:(exclude,literal)${entry}`);
                  }
                }
                if (exclusions.length === 0) return yield* error;
                return yield* stageFiles(exclusions);
              }).pipe(
                Effect.timeoutOrElse({
                  duration: CHECKPOINT_RECOVERY_TIMEOUT,
                  orElse: () => Effect.fail(error),
                }),
              ),
          }),
        );

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...indexConfig, ...durableWrite, "write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `t3 checkpoint ref=${input.checkpointRef}`;
        // HEAD is the parent so listAuthoredPaths can see how HEAD moved between checkpoints.
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...durableWrite,
            "commit-tree",
            treeOid,
            ...(headExists ? ["-p", "HEAD"] : []),
            "-m",
            message,
          ],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", input.checkpointRef, commitOid],
        });
      }).pipe(Effect.ensuring(cleanupTempIndex));
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
      });
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      if (tracked.stdout.length > 0) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...longPaths,
            "restore",
            "--source",
            commitOid,
            "--worktree",
            "--staged",
            "--",
            ".",
          ],
        });
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      const recreateWorkspace = fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      yield* recreateWorkspace;
      const cleaned = yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "clean", "-fd", "--", "."],
        allowNonZeroExit: true,
      });
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace)
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
      }
      // On Windows the same clean can remove './' and exit 0.
      yield* recreateWorkspace;

      yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "reset", "--quiet", "--", "."],
      });

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          // Not --no-relative, which Git before 2.28 rejects.
          "-c",
          "diff.relative=false",
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--submodule=short",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        allowNonZeroExit: true,
        maxOutputBytes: input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    listAuthoredPaths: Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
      const heads = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%P %ct",
          `${input.fromCheckpointRef}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
      });
      const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
      const [startHead = "", capturedAt = ""] = fromLine.split(" ");
      const [endHead = ""] = toLine.split(" ");
      if (startHead === "" || endHead === "" || startHead === endHead) {
        return null;
      }

      const listPaths = (args: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [
            "-c",
            "diff.relative=false",
            // log.showSignature prints verification text into the path list.
            "-c",
            "log.showSignature=false",
            ...args,
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
          ],
          maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\0")));
      // Remerge diffs retain merge conflict fixes while excluding clean upstream changes.
      const pathLists = yield* Effect.all(
        [
          listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
          listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
          listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
          listPaths([
            "log",
            "--format=",
            "--diff-merges=remerge",
            `--since=@${capturedAt}`,
            `${startHead}..${endHead}`,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      return new Set(pathLists.flat().filter((path) => path.length > 0));
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});
