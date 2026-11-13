import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import { GitCommandError, type ReviewBranchCommitsInput, type ReviewDiffFileContentsInput, type ReviewDiffPreviewInput, type ReviewDiffFileStat, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { parseRemoteRefWithRemoteNames } from "../../git/remoteRefs.ts";
import { REVIEW_BRANCH_COMMIT_LIMIT, REVIEW_BRANCH_COMMIT_MAX_OUTPUT_BYTES, REVIEW_BRANCH_SUBJECT_LIMIT, REVIEW_DIFF_ARGS, REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES, REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES, REVIEW_METADATA_MAX_OUTPUT_BYTES, isMissingGitCwdError, isUnbornHeadStderr, parseReviewNumstat, refuseOptionLikeRefName } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";
import type { ResolveBaseBranchForNoUpstreamPart } from "./ResolveBaseBranchForNoUpstream.ts";
import type { ReadStatusDetailsLocalPart } from "./ReadStatusDetailsLocal.ts";
import type { PushCurrentBranchPart } from "./PushCurrentBranch.ts";

type Deps = Record<never, never> & ExecuteRawPart & ResolveBaseBranchForNoUpstreamPart & ReadStatusDetailsLocalPart & PushCurrentBranchPart;

export const installGetReviewDiffPreview = Effect.fnUntraced(function* (deps: Deps) {
  const { commit, digest, executeGit, executeGitWithStableDiagnostics, fileSystem, isServerInternalPath, listRemoteNames, path, prepareUntrackedReviewIndex, readEmptyTreeHash, readReviewCommitMessage, remoteBranchExists, resolvePrimaryRemoteName, resolveRepositoryPathsUncached, resolveReviewCommit, resolveReviewMergeBase, resolveReviewWorktreeRoot, retryWhileConfigLocked, reviewCommitError, runGitStdout, runGitStdoutWithOptions } = deps;

const getReviewBranchCommits = Effect.fn("getReviewBranchCommits")(function* (
  input: ReviewBranchCommitsInput,
) {
  const repository = yield* resolveRepositoryPathsUncached(input.cwd);
  if (!repository?.worktreeRoot) return { commits: [], truncated: false };
  const cwd = repository.worktreeRoot;
  const head = yield* executeGit(
    "GitVcsDriver.getReviewBranchCommits.head",
    cwd,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { allowNonZeroExit: true },
  );
  if (head.exitCode !== 0) {
    if (head.exitCode === 1 && head.stderr.trim() === "") {
      return { commits: [], truncated: false };
    }
    return yield* reviewCommitError(cwd, "Could not resolve the current branch commit.");
  }
  const { mergeBase } = yield* resolveReviewMergeBase(
    cwd,
    repository.currentBranch,
    input.baseRef,
  );
  const result = yield* executeGit(
    "GitVcsDriver.getReviewBranchCommits",
    cwd,
    [
      "log",
      "-z",
      "--no-notes",
      "--no-show-signature",
      "--format=%H%x00%s%x00%cI",
      `--max-count=${REVIEW_BRANCH_COMMIT_LIMIT + 1}`,
      `${mergeBase}..HEAD`,
    ],
    {
      maxOutputBytes: REVIEW_BRANCH_COMMIT_MAX_OUTPUT_BYTES,
      appendTruncationMarker: true,
    },
  );
  if (!result.stdoutTruncated && result.stdout.length > 0 && !result.stdout.endsWith("\0")) {
    return yield* reviewCommitError(cwd, "Could not read branch commit metadata.");
  }
  const fields = result.stdout.split("\0");
  const completeFieldCount = fields.length - 1;
  const commits: Array<{ sha: string; subject: string; committedAt: string }> = [];
  for (
    let index = 0;
    index + 2 < completeFieldCount && commits.length <= REVIEW_BRANCH_COMMIT_LIMIT;
    index += 3
  ) {
    const sha = fields[index];
    const subject = fields[index + 1];
    const committedAt = fields[index + 2];
    if (
      !sha ||
      subject === undefined ||
      !committedAt ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)
    ) {
      return yield* reviewCommitError(cwd, "Could not read branch commit metadata.");
    }
    commits.push({ sha, subject: subject.slice(0, REVIEW_BRANCH_SUBJECT_LIMIT), committedAt });
  }
  if (result.stdoutTruncated && commits.length === 0) {
    return yield* reviewCommitError(cwd, "Branch commit metadata exceeds the response limit.");
  }
  return {
    commits: commits.slice(0, REVIEW_BRANCH_COMMIT_LIMIT),
    truncated: result.stdoutTruncated || commits.length > REVIEW_BRANCH_COMMIT_LIMIT,
  };
});

const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
  input: ReviewDiffPreviewInput,
) {
  const pathArgs = input.file
    ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])].map(
        (path) => `:(top,literal)${path}`,
      )
    : [];
  const patchLimit = input.file
    ? REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES
    : REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES;
  const needsCurrentBranch =
    input.commitSha === undefined &&
    input.file?.sourceKind !== "commit" &&
    input.file?.sourceKind !== "working-tree";
  const repository = yield* (
    needsCurrentBranch
      ? resolveRepositoryPathsUncached(input.cwd)
      : resolveReviewWorktreeRoot(input.cwd)
  ).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  if (!repository?.worktreeRoot) {
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [],
    };
  }

  const cwd = repository.worktreeRoot;
  const hashDiff = (diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(JSON.stringify([diff, files]))).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.getReviewDiffPreview.hash",
            command: "crypto.digest SHA-256",
            cwd,
            detail: "Failed to hash review diff.",
            cause,
          }),
      ),
    );
  if (input.commitSha !== undefined || input.file?.sourceKind === "commit") {
    if (!input.commitSha || (input.file && input.file.sourceKind !== "commit")) {
      return yield* reviewCommitError(cwd, "Selected commit request is invalid.");
    }
    const commit = yield* resolveReviewCommit(cwd, input.commitSha);
    const { subject } = yield* readReviewCommitMessage(cwd, commit.sha);
    const diffArgs = [
      ...REVIEW_DIFF_ARGS,
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const stat = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.commitStat",
      cwd,
      [...diffArgs, "--numstat", "-z", commit.parent, commit.sha, "--", ...pathArgs],
      { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
    );
    const files = parseReviewNumstat(stat.stdout);
    const patch = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.commitPatch",
      cwd,
      [...diffArgs, "--patch", commit.parent, commit.sha, "--", ...pathArgs],
      { maxOutputBytes: patchLimit, appendTruncationMarker: true },
    );
    const diffHash = yield* hashDiff(patch.stdout, files);
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [
        {
          id: commit.sha,
          kind: "commit" as const,
          title: `Commit ${commit.sha.slice(0, 7)}`,
          ...(subject.trim() ? { commitSubject: subject.trim() } : {}),
          baseRef: commit.parent,
          headRef: commit.sha,
          diff: patch.stdout,
          files,
          diffHash,
          truncated: patch.stdoutTruncated,
        },
      ],
    };
  }

  const dirtyRef = input.file?.sourceKind === "branch-range" ? null : "HEAD";
  const review =
    input.file?.sourceKind === "working-tree"
      ? { baseRef: input.baseRef ?? null, mergeBase: null }
      : yield* resolveReviewMergeBase(cwd, repository.currentBranch, input.baseRef);

  const diffArgs = [
    ...REVIEW_DIFF_ARGS,
    "--minimal",
    ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
  ];
  const readStats = Effect.fn("GitVcsDriver.getReviewDiffPreview.stat")(function* (
    ref: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const args = [...diffArgs, "--numstat", "-z"];
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.stat",
      cwd,
      [...args, ref, "--", ...pathArgs],
      { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES, env },
    );
    if (result.exitCode === 0) return { ref, files: parseReviewNumstat(result.stdout) };
    if (ref === "HEAD" && isUnbornHeadStderr(result.stderr)) {
      const emptyTree = yield* readEmptyTreeHash(cwd);
      const stdout = yield* runGitStdoutWithOptions(
        "GitVcsDriver.getReviewDiffPreview.unbornStat",
        cwd,
        [...args, emptyTree, "--", ...pathArgs],
        { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES, env },
      );
      return { ref: emptyTree, files: parseReviewNumstat(stdout) };
    }
    return yield* new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffPreview.stat",
      cwd,
      command: "git diff --numstat",
      detail: "Could not read complete diff statistics.",
      exitCode: result.exitCode,
    });
  });
  const readTrackedDiff = Effect.fn("GitVcsDriver.getReviewDiffPreview.tracked")(function* (
    ref: string | null,
    env?: NodeJS.ProcessEnv,
  ) {
    if (ref === null) return { stdout: "", stdoutTruncated: false, files: [] };
    const stat = yield* readStats(ref, env);
    if (stat.files.length === 0) return { stdout: "", stdoutTruncated: false, files: [] };
    const patch = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.patch",
      cwd,
      [...diffArgs, "--patch", stat.ref, "--", ...pathArgs],
      { maxOutputBytes: patchLimit, appendTruncationMarker: true, env },
    );
    return { ...patch, files: stat.files };
  });
  const [dirtyTrackedResult, baseResult] = yield* Effect.gen(function* () {
    const untracked = yield* prepareUntrackedReviewIndex(cwd, pathArgs, input.file?.path);
    const [dirty, base] =
      review.mergeBase === dirtyRef
        ? yield* readTrackedDiff(dirtyRef, untracked?.env).pipe(
            Effect.map((result) => [result, result] as const),
          )
        : yield* Effect.all(
            [
              readTrackedDiff(dirtyRef, untracked?.env),
              readTrackedDiff(review.mergeBase, untracked?.env),
            ],
            { concurrency: 2 },
          );
    if (untracked !== null) return [dirty, base] as const;
    const incomplete = (ref: string | null, result: typeof dirty) =>
      ref === null ? result : { ...result, files: undefined, stdoutTruncated: true };
    return [incomplete(dirtyRef, dirty), incomplete(review.mergeBase, base)] as const;
  }).pipe(Effect.scoped);
  const dirtyFiles = dirtyTrackedResult.files;
  const baseFiles = baseResult.files;
  const dirtyDiff = dirtyTrackedResult.stdout;
  const baseDiff = baseResult.stdout;
  const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
    hashDiff(dirtyDiff, dirtyFiles ?? []),
    hashDiff(baseDiff, baseFiles ?? []),
  ]);

  const sources: ReviewDiffPreviewSource[] = [
    {
      id: "working-tree",
      kind: "working-tree",
      title: "Uncommitted",
      baseRef: "HEAD",
      headRef: null,
      diff: dirtyDiff,
      ...(dirtyFiles === undefined ? {} : { files: dirtyFiles }),
      diffHash: dirtyDiffHash,
      truncated: dirtyTrackedResult.stdoutTruncated,
    },
    {
      id: "branch-range",
      kind: "branch-range",
      title: review.baseRef ? `Changes vs ${review.baseRef}` : "Changes",
      baseRef: review.baseRef,
      headRef: repository.currentBranch ?? "HEAD",
      diff: baseDiff,
      ...(baseFiles === undefined ? {} : { files: baseFiles }),
      diffHash: baseDiffHash,
      truncated: baseResult.stdoutTruncated,
    },
  ];

  return {
    cwd: input.cwd,
    generatedAt: yield* DateTime.now,
    sources,
  };
});

const reviewDiffFileError = (
  input: ReviewDiffFileContentsInput,
  detail: string,
  cause?: unknown,
) =>
  new GitCommandError({
    operation: "GitVcsDriver.getReviewDiffFileContents",
    command: "git",
    cwd: input.cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const isPathWithinRoot = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const readReviewFileAtRevision = Effect.fn("readReviewFileAtRevision")(function* (
  input: ReviewDiffFileContentsInput,
  revision: string,
  relativePath: string,
) {
  const result = yield* executeGit(
    "GitVcsDriver.getReviewDiffFileContents.revision",
    input.cwd,
    ["show", "--end-of-options", `${revision}:${relativePath}`],
    { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
  );
  if (result.stdout.includes("\0")) {
    return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
  }
  return result.stdout;
});

const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
  input: ReviewDiffFileContentsInput,
  repositoryRoot: string,
) {
  const fileError = (stage: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: `GitVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
      command: stage,
      cwd: input.cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const requestedPath = path.resolve(repositoryRoot, input.newPath);
  if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
    return yield* fileError(
      "path.resolve",
      `Diff file '${input.newPath}' resolves outside the review workspace.`,
    );
  }

  const [realRepositoryRoot, realTarget] = yield* Effect.all([
    fileSystem.realPath(repositoryRoot),
    fileSystem.realPath(requestedPath),
  ]).pipe(
    Effect.mapError((cause) =>
      fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
    ),
  );
  if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
    return yield* fileError(
      "fs.realPath",
      `Diff file '${input.newPath}' resolves outside the review workspace.`,
    );
  }
  if (yield* isServerInternalPath(realTarget)) {
    return yield* fileError("fs.realPath", `Diff file '${input.newPath}' is not available.`);
  }

  const info = yield* fileSystem
    .stat(realTarget)
    .pipe(
      Effect.mapError((cause) =>
        fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
      ),
    );
  if (info.type !== "File") {
    return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
  }
  if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
    return yield* fileError(
      "fs.stat",
      `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
    );
  }

  const bytes = yield* fileSystem
    .readFile(realTarget)
    .pipe(
      Effect.mapError((cause) =>
        fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
      ),
    );
  if (bytes.includes(0)) {
    return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
});

const getReviewDiffFileContents = Effect.fn("getReviewDiffFileContents")(function* (
  input: ReviewDiffFileContentsInput,
) {
  const repositoryRoot = yield* runGitStdout(
    "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
    input.cwd,
    ["rev-parse", "--show-toplevel"],
  ).pipe(Effect.map((value) => value.trim()));
  if (repositoryRoot.length === 0) {
    return yield* reviewDiffFileError(input, "Could not resolve the Git repository root.");
  }
  if (input.sourceKind === "commit") {
    if (!input.headRef) {
      return yield* reviewDiffFileError(input, "Selected commit is no longer available.");
    }
    const commit = yield* resolveReviewCommit(input.cwd, input.headRef);
    if (input.baseRef !== commit.parent) {
      return yield* reviewDiffFileError(
        input,
        "Selected commit changed. Refresh the comparison.",
      );
    }
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, commit.parent, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, commit.sha, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  }
  const oldRevision =
    input.sourceKind === "working-tree"
      ? (input.baseRef ?? "HEAD")
      : (yield* resolveReviewMergeBase(input.cwd, null, input.baseRef ?? undefined)).mergeBase;
  const [oldContents, newContents] = yield* Effect.all(
    [
      input.changeType === "new"
        ? Effect.succeed("")
        : readReviewFileAtRevision(input, oldRevision, input.oldPath),
      input.changeType === "deleted"
        ? Effect.succeed("")
        : readWorkingTreeReviewFile(input, repositoryRoot),
    ],
    { concurrency: 2 },
  );
  return { oldContents, newContents };
});

const createBranchAt = Effect.fn("createBranchAt")(function* (
  operation: string,
  input: GitVcsDriver.GitCreateBranchInput,
  fallbackErrorDetail: string,
) {
  // `git branch` does not read a lone - as the previous checkout.
  const startPoint = input.startPoint === "-" ? "@{-1}" : input.startPoint;
  yield* executeGitWithStableDiagnostics(
    operation,
    input.cwd,
    ["branch", "--no-track", "--", input.branch, startPoint],
    { fallbackErrorDetail },
  );
  const startRef = yield* executeGit(
    `${operation}.resolveStartPoint`,
    input.cwd,
    ["rev-parse", "--symbolic-full-name", startPoint],
    { allowNonZeroExit: true },
  ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
  if (!startRef.startsWith("refs/remotes/")) return;
  yield* executeGitWithStableDiagnostics(
    `${operation}.track`,
    input.cwd,
    ["branch", `--set-upstream-to=${startRef}`, "--", input.branch],
    { writesSharedConfig: true },
  ).pipe(
    retryWhileConfigLocked,
    Effect.catch((cause) =>
      Effect.logWarning("created the branch without tracking its start point", { cause }),
    ),
  );
});

const createBranch: GitVcsDriver.GitVcsDriver["Service"]["createBranch"] = Effect.fn(
  "createBranch",
)(function* (input) {
  yield* refuseOptionLikeRefName("GitVcsDriver.createBranch", input.cwd, input.startPoint);
  yield* createBranchAt("GitVcsDriver.createBranch", input, "git branch create failed");
});

const resolveBranchBase = Effect.fn("GitVcsDriver.resolveBranchBase")(function* (
  cwd: string,
  refName: string,
) {
  const result = yield* executeGit(
    "GitVcsDriver.resolveBranchName.resolveRef",
    cwd,
    ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", refName],
    { allowNonZeroExit: true },
  );
  if (result.exitCode !== 0) {
    const remoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    return remoteName && (yield* remoteBranchExists({ cwd, remoteName, refName }))
      ? { baseRef: `refs/remotes/${remoteName}/${refName}`, branchName: refName }
      : null;
  }
  const ref = result.stdout.trim();
  if (ref.startsWith("refs/heads/")) {
    const branchName = ref.slice("refs/heads/".length);
    return { baseRef: ref, branchName };
  }
  if (!ref.startsWith("refs/remotes/")) return null;
  const remoteNames = yield* listRemoteNames(cwd);
  const remoteRef = parseRemoteRefWithRemoteNames(
    ref.slice("refs/remotes/".length),
    remoteNames.toSorted((left, right) => right.length - left.length),
  );
  return remoteRef ? { baseRef: ref, branchName: remoteRef.branchName } : null;
});

const resolveBranchName = Effect.fn("GitVcsDriver.resolveBranchName")(function* (
  cwd: string,
  refName: string,
) {
  const base = yield* resolveBranchBase(cwd, refName);
  return base?.branchName ?? null;
});

  return { getReviewBranchCommits, getReviewDiffPreview, reviewDiffFileError, isPathWithinRoot, readReviewFileAtRevision, readWorkingTreeReviewFile, getReviewDiffFileContents, createBranchAt, createBranch, resolveBranchBase, resolveBranchName };
});

export type GetReviewDiffPreviewPart = ReturnType<typeof installGetReviewDiffPreview> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installGetReviewDiffPreview>;
