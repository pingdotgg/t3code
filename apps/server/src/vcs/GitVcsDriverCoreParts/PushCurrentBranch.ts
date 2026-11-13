import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { GitCommandError } from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES, RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES, RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES, RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES, REVIEW_METADATA_MAX_OUTPUT_BYTES, branchBaseConfigKey, branchNameFromHeadRef, classifyGitFailure, fetchFailureDetail, gitCommandContext, isRefLockFailure } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";
import type { ResolveBaseBranchForNoUpstreamPart } from "./ResolveBaseBranchForNoUpstream.ts";
import type { ReadStatusDetailsLocalPart } from "./ReadStatusDetailsLocal.ts";

type Deps = Record<never, never> & ExecuteRawPart & ResolveBaseBranchForNoUpstreamPart & ReadStatusDetailsLocalPart;

export const installPushCurrentBranch = Effect.fnUntraced(function* (deps: Deps) {
  const { executeGit, executeGitWithStableDiagnostics, fileSystem, path, readBranchBase, readConfigValue, readEmptyTreeHash, readStatusDetailsLocal, resolveBaseBranchForNoUpstream, resolveCurrentUpstream, resolveGitCommonDir, resolvePublishBranchName, resolvePushRemoteName, retryWhileConfigLocked, runGit, runGitStdout, runGitStdoutWithOptions, stageCommitChanges, statusDetails, statusFetches } = deps;

const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
  Effect.fn("prepareCommitContext")(function* (cwd, filePaths, options) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const indexValue = yield* runGitStdout(
          "GitVcsDriver.prepareCommitContext.indexPath",
          cwd,
          ["rev-parse", "--git-path", "index"],
        );
        const indexPath = path.resolve(cwd, indexValue.trim());
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-commit-index-",
        });
        const tempIndexPath = path.join(directory, "index");
        const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
        const config = [
          "-c",
          "core.splitIndex=false",
          "-c",
          "splitIndex.sharedIndexExpire=never",
        ];
        if (yield* fileSystem.exists(indexPath)) {
          const { mtime } = yield* fileSystem.stat(indexPath);
          yield* fileSystem.copyFile(indexPath, tempIndexPath);
          const indexTime = Option.isSome(mtime)
            ? Math.max(0, Math.floor(mtime.value.getTime() / 1000))
            : 0;
          yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
          yield* runGit(
            "GitVcsDriver.prepareCommitContext.expandSplitIndex",
            cwd,
            [...config, "update-index", "--no-split-index"],
            { env },
          );
        } else {
          yield* runGit(
            "GitVcsDriver.prepareCommitContext.emptyIndex",
            cwd,
            [...config, "read-tree", "--empty"],
            { env },
          );
        }
        yield* stageCommitChanges(cwd, filePaths, env);

        const stagedSummary = yield* runGitStdoutWithOptions(
          "GitVcsDriver.prepareCommitContext.stagedSummary",
          cwd,
          // cwd can be a subdirectory; diff.relative would hide changes outside it.
          ["-c", "diff.relative=false", "diff", "--cached", "--name-status"],
          { env, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (stagedSummary.length === 0) {
          return null;
        }

        // A user-supplied message needs change detection, but no patch for generation.
        if (options?.includePatch === false) return { stagedSummary, stagedPatch: "" };

        const stagedPatch = yield* runGitStdoutWithOptions(
          "GitVcsDriver.prepareCommitContext.stagedPatch",
          cwd,
          [
            "-c",
            "diff.relative=false",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--cached",
            "--patch",
            "--minimal",
          ],
          {
            env,
            maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        );

        return {
          stagedSummary,
          stagedPatch,
        };
      }),
    ).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.prepareCommitContext",
            command: "git",
            cwd,
            detail: "Failed to prepare the temporary commit index.",
            cause,
          }),
      }),
    );
  });

const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
  cwd,
  subject,
  body,
  options?: GitVcsDriver.GitCommitOptions,
) {
  if (options?.stage !== undefined) {
    yield* stageCommitChanges(cwd, options.stage.filePaths);
  }
  const args = ["commit", "-m", subject];
  const trimmedBody = body.trim();
  if (trimmedBody.length > 0) {
    args.push("-m", trimmedBody);
  }
  const progress =
    options?.progress?.onOutputLine === undefined
      ? options?.progress
      : {
          ...options.progress,
          onStdoutLine: (line: string) =>
            options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
          onStderrLine: (line: string) =>
            options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
        };
  yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
    maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(progress ? { progress } : {}),
  }).pipe(Effect.asVoid);
  const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
    "rev-parse",
    "HEAD",
  ]).pipe(Effect.map((stdout) => stdout.trim()));

  return { commitSha };
});

const recordPushedUpstream = Effect.fn("recordPushedUpstream")(
  function* (cwd: string, branch: string, remoteName: string, publishBranch: string) {
    // Without a prior upstream, Git ignores a merge ref with no remote, so losing the second
    // write leaves none rather than a wrong one.
    yield* writeConfigValue({
      cwd,
      key: `branch.${branch}.merge`,
      value: `refs/heads/${publishBranch}`,
    });
    yield* writeConfigValue({ cwd, key: `branch.${branch}.remote`, value: remoteName });
    // Matches what `push -u` sets for a remote upstream.
    const autoSetupRebase = yield* readConfigValue(cwd, "branch.autoSetupRebase");
    if (autoSetupRebase === "always" || autoSetupRebase === "remote") {
      yield* writeConfigValue({ cwd, key: `branch.${branch}.rebase`, value: "true" });
    }
    return true;
  },
  Effect.catch((cause) =>
    Effect.logWarning("pushed, but could not record the branch upstream", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);

const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
  "pushCurrentBranch",
)(function* (cwd, fallbackBranch, options) {
  const details = yield* statusDetails(cwd);
  const branch = details.branch ?? fallbackBranch;
  if (!branch) {
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.pushCurrentBranch",
        cwd,
        args: ["push"],
      }),
      detail: "Cannot push from detached HEAD.",
    });
  }

  const requestedRemoteName = options?.remoteName?.trim() || null;
  if (requestedRemoteName) {
    const publishBranch = yield* resolvePublishBranchName(cwd, branch);
    yield* runGit(
      "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
      cwd,
      ["push", "--", requestedRemoteName, `HEAD:refs/heads/${publishBranch}`],
      { timeoutMs: null },
    );
    return {
      status: "pushed" as const,
      branch,
      upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
      setUpstream: yield* recordPushedUpstream(cwd, branch, requestedRemoteName, publishBranch),
    };
  }

  const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
  if (hasNoLocalDelta) {
    if (details.hasUpstream) {
      return {
        status: "skipped_up_to_date" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      };
    }

    const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (comparableBaseBranch) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!publishRemoteName) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
        };
      }

      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      // The configured diff base can contain HEAD while the publish branch is still behind.
      const publishContainsHead = yield* executeGit(
        "GitVcsDriver.pushCurrentBranch.publishContainsHead",
        cwd,
        [
          "merge-base",
          "--is-ancestor",
          "HEAD",
          `refs/remotes/${publishRemoteName}/${publishBranch}`,
        ],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );
      if (publishContainsHead) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
        };
      }
    }
  }

  if (!details.hasUpstream) {
    const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
    if (!publishRemoteName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push because no git remote is configured for this repository.",
      });
    }
    const publishBranch = yield* resolvePublishBranchName(cwd, branch);
    yield* runGit(
      "GitVcsDriver.pushCurrentBranch.pushWithUpstream",
      cwd,
      ["push", "--", publishRemoteName, `HEAD:refs/heads/${publishBranch}`],
      { timeoutMs: null },
    );
    return {
      status: "pushed" as const,
      branch,
      upstreamBranch: `${publishRemoteName}/${publishBranch}`,
      setUpstream: yield* recordPushedUpstream(cwd, branch, publishRemoteName, publishBranch),
    };
  }

  const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (currentUpstream) {
    // Differently named upstreams are bases, not publish targets; pushing HEAD there would write features to shared branches.
    const isAliasOfUpstreamHead =
      branch === currentUpstream.branchName ||
      (branch.endsWith(`/${currentUpstream.branchName}`) &&
        currentUpstream.upstreamRef.endsWith(`/${branch}`));
    if (!isAliasOfUpstreamHead) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      const remoteName = publishRemoteName ?? currentUpstream.remoteName;
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      // Publishing retargets the upstream, so preserve its comparison base first.
      if ((yield* readBranchBase(cwd, branch)) === null) {
        yield* writeConfigValue({
          cwd,
          key: branchBaseConfigKey(branch),
          value: currentUpstream.branchName,
        });
        if (!(yield* readConfigValue(cwd, `branch.${branch}.t3-merge-base-ref`))) {
          yield* writeConfigValue({
            cwd,
            key: `branch.${branch}.t3-merge-base-ref`,
            value: `refs/remotes/${currentUpstream.upstreamRef}`,
          });
        }
      }
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushOwnBranch",
        cwd,
        ["push", "--", remoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${remoteName}/${publishBranch}`,
        setUpstream: yield* recordPushedUpstream(cwd, branch, remoteName, publishBranch),
      };
    }

    yield* runGit(
      "GitVcsDriver.pushCurrentBranch.pushUpstream",
      cwd,
      ["push", "--", currentUpstream.remoteName, `HEAD:refs/heads/${currentUpstream.branchName}`],
      { timeoutMs: null },
    );
    return {
      status: "pushed" as const,
      branch,
      upstreamBranch: currentUpstream.upstreamRef,
      setUpstream: false,
    };
  }

  yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"], { timeoutMs: null });
  return {
    status: "pushed" as const,
    branch,
    ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
    setUpstream: false,
  };
});

const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
  "pullCurrentBranch",
)(function* (cwd) {
  const details = yield* readStatusDetailsLocal(cwd);
  const refName = details.branch;
  if (!refName) {
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.pullCurrentBranch",
        cwd,
        args: ["pull", "--ff-only"],
      }),
      detail: "Cannot pull from detached HEAD.",
    });
  }
  if (!details.hasUpstream) {
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.pullCurrentBranch",
        cwd,
        args: ["pull", "--ff-only"],
      }),
      detail: "Current branch has no upstream configured. Push with upstream first.",
    });
  }
  const remote = yield* readConfigValue(cwd, `branch.${refName}.remote`);
  if (remote) {
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    const pending = statusFetches.get(`${gitCommonDir}\0${remote}`);
    // The status wait can finish while its fetch still owns reference locks.
    // Let our existing writer finish before starting the pull's fetch.
    if (pending) yield* Fiber.await(pending);
  }
  const beforeSha = yield* runGitStdout(
    "GitVcsDriver.pullCurrentBranch.beforeSha",
    cwd,
    ["rev-parse", "HEAD"],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));
  // After a successful pull, HEAD before and after decides the result, so its output is not
  // needed. A large fast-forward's diffstat can exceed the output cap, which must not fail a
  // pull Git applied.
  const options = {
    timeoutMs: 30_000,
    appendTruncationMarker: true,
    allowNonZeroExit: true,
  };
  let args = ["pull", "--ff-only"];
  let result = yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.pullCurrentBranch.pull",
    cwd,
    args,
    options,
  );
  if (result.exitCode !== 0 && isRefLockFailure(result.stderr)) {
    const [remote, mergeRefs, currentBranch, currentSha] = yield* Effect.all([
      readConfigValue(cwd, `branch.${refName}.remote`),
      runGitStdout(
        "GitVcsDriver.pullCurrentBranch.mergeRefs",
        cwd,
        ["config", "--get-all", `branch.${refName}.merge`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim().split("\n").filter(Boolean))),
      runGitStdout(
        "GitVcsDriver.pullCurrentBranch.currentBranch",
        cwd,
        ["symbolic-ref", "--quiet", "HEAD"],
        true,
      ).pipe(Effect.map(branchNameFromHeadRef)),
      runGitStdout("GitVcsDriver.pullCurrentBranch.currentSha", cwd, ["rev-parse", "HEAD"]).pipe(
        Effect.map((stdout) => stdout.trim()),
      ),
    ]);
    // A full fetch can fail on an unrelated branch's lock. Keep that fetch as the
    // default, but retry only the configured upstream before any checkout movement.
    const [mergeRef] = mergeRefs;
    if (
      remote &&
      mergeRef &&
      mergeRefs.length === 1 &&
      currentBranch === refName &&
      currentSha === beforeSha
    ) {
      args = ["pull", "--ff-only", "--", remote, mergeRef];
      result = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.pullCurrentBranch.pull",
        cwd,
        args,
        options,
      );
    }
  }
  if (result.exitCode !== 0) {
    const reason = classifyGitFailure(result.stderr);
    return yield* new GitCommandError({
      ...gitCommandContext({ operation: "GitVcsDriver.pullCurrentBranch.pull", cwd, args }),
      ...(reason === null ? {} : { reason }),
      detail: fetchFailureDetail(result.stderr) ?? "git pull failed",
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });
  }
  const afterSha = yield* runGitStdout(
    "GitVcsDriver.pullCurrentBranch.afterSha",
    cwd,
    ["rev-parse", "HEAD"],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim()));

  const refreshed = yield* readStatusDetailsLocal(cwd);
  return {
    status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
    refName,
    upstreamRef: refreshed.upstreamRef,
  };
});

const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
  "readRangeContext",
)(function* (cwd, baseRef) {
  const commitRange = `${baseRef}..HEAD`;
  const diffRange = `${baseRef}...HEAD`;
  const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
    [
      runGitStdoutWithOptions(
        "GitVcsDriver.readRangeContext.log",
        cwd,
        [
          "log",
          "--oneline",
          "--no-color",
          "--no-decorate",
          "--no-show-signature",
          "--end-of-options",
          commitRange,
        ],
        {
          maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      ),
      runGitStdoutWithOptions(
        "GitVcsDriver.readRangeContext.diffStat",
        cwd,
        [
          "-c",
          "diff.relative=false",
          "diff",
          "--stat",
          "--no-color",
          "--end-of-options",
          diffRange,
        ],
        {
          maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      ),
      runGitStdoutWithOptions(
        "GitVcsDriver.readRangeContext.diffPatch",
        cwd,
        [
          "-c",
          "diff.relative=false",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--patch",
          "--minimal",
          "--end-of-options",
          diffRange,
        ],
        {
          maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      ),
    ],
    { concurrency: "unbounded" },
  );

  return {
    commitSummary,
    diffSummary,
    diffPatch,
  };
});

const reviewCommitError = (cwd: string, detail: string) =>
  new GitCommandError({
    operation: "GitVcsDriver.reviewCommit",
    command: "git cat-file",
    cwd,
    detail,
  });

const resolveReviewCommit = Effect.fn("resolveReviewCommit")(function* (
  cwd: string,
  sha: string,
) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
    return yield* reviewCommitError(cwd, "Selected commit is invalid or no longer available.");
  }
  const present = yield* executeGit(
    "GitVcsDriver.reviewCommit.present",
    cwd,
    ["cat-file", "-e", `${sha}^{commit}`],
    { allowNonZeroExit: true, env: { GIT_NO_LAZY_FETCH: "1" } },
  );
  if (present.exitCode !== 0) {
    return yield* reviewCommitError(cwd, "Selected commit is invalid or no longer available.");
  }
  // The raw object keeps the parents a shallow clone grafts away, so a boundary is not a root.
  const object = yield* runGitStdout("GitVcsDriver.reviewCommit.parents", cwd, [
    "cat-file",
    "commit",
    sha,
  ]);
  const secondLine = object.split("\n", 2)[1];
  const firstParent = secondLine?.startsWith("parent ") ? secondLine.slice(7) : undefined;
  if (firstParent !== undefined) {
    const parent = yield* executeGit(
      "GitVcsDriver.reviewCommit.parent",
      cwd,
      ["cat-file", "-e", `${firstParent}^{commit}`],
      { allowNonZeroExit: true, env: { GIT_NO_LAZY_FETCH: "1" } },
    );
    if (parent.exitCode !== 0) {
      return yield* reviewCommitError(cwd, "Selected commit's parent is not available locally.");
    }
  }
  return { sha: sha.toLowerCase(), parent: firstParent ?? (yield* readEmptyTreeHash(cwd)) };
});

const readReviewCommitMessage = Effect.fn("GitVcsDriver.readReviewCommitMessage")(function* (
  cwd: string,
  sha: string,
) {
  const result = yield* executeGit(
    "GitVcsDriver.readReviewCommitMessage",
    cwd,
    ["show", "-s", "--no-notes", "--no-show-signature", "--format=%B", sha],
    { maxOutputBytes: 8_192, appendTruncationMarker: true },
  );
  const endOfSubject = result.stdout.indexOf("\n");
  return {
    subject: result.stdout.slice(0, endOfSubject < 0 ? undefined : endOfSubject).slice(0, 300),
  };
});

const writeConfigValue: GitVcsDriver.GitVcsDriver["Service"]["writeConfigValue"] = Effect.fn(
  "writeConfigValue",
)(function* (input) {
  yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.writeConfigValue",
    input.cwd,
    ["config", input.key, input.value],
    { writesSharedConfig: true },
  ).pipe(retryWhileConfigLocked);
});

  return { prepareCommitContext, commit, recordPushedUpstream, pushCurrentBranch, pullCurrentBranch, readRangeContext, reviewCommitError, resolveReviewCommit, readReviewCommitMessage, writeConfigValue };
});

export type PushCurrentBranchPart = ReturnType<typeof installPushCurrentBranch> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installPushCurrentBranch>;
