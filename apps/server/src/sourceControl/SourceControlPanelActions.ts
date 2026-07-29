import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import {
  GitCommandError,
  type VcsPanelCompareInput,
  type VcsPanelCompareResult,
} from "@t3tools/contracts";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import type { ExecuteGitProgress } from "../vcs/GitVcsDriver.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { parsePathLines, uniquePaths } from "./SourceControlPanelParsers.ts";
import type { SourceControlPanelService } from "./SourceControlPanelService.ts";

export type SourceControlPanelActionMethodName =
  | "stageFiles"
  | "unstageFiles"
  | "discardFiles"
  | "readFileDiff"
  | "commitStaged"
  | "pullBranch"
  | "pushBranch"
  | "deleteBranch"
  | "undoLatestCommit"
  | "revertCommit"
  | "checkoutCommit"
  | "createBranchFromCommit"
  | "mergeBranchIntoCurrent"
  | "rebaseCurrentOnto"
  | "fetchBranch"
  | "fetchRemote"
  | "addRemote"
  | "removeRemote"
  | "createStash"
  | "applyStash"
  | "popStash"
  | "dropStash"
  | "compare";

export const SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS = [
  "commitStaged",
  "pullBranch",
  "pushBranch",
  "deleteBranch",
  "undoLatestCommit",
  "revertCommit",
  "checkoutCommit",
  "createBranchFromCommit",
  "mergeBranchIntoCurrent",
  "rebaseCurrentOnto",
  "fetchBranch",
  "fetchRemote",
  "addRemote",
  "removeRemote",
] as const satisfies readonly SourceControlPanelActionMethodName[];

interface RunOptions {
  readonly allowNonZeroExit?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly progress?: ExecuteGitProgress;
}
type Run = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: RunOptions,
) => Effect.Effect<string, GitCommandError>;
type TemporaryIndex = <A, E>(
  input: {
    readonly cwd: string;
    readonly paths: readonly string[];
    readonly operations: {
      readonly gitIndexPath: string;
      readonly tempIndexReadTree: string;
      readonly tempIndexIntentToAdd: string;
    };
  },
  use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | GitCommandError | PlatformError.PlatformError>;
type SelectedIndex = <A, E>(
  cwd: string,
  paths: readonly string[],
  use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | GitCommandError>;

export interface SourceControlPanelActionDependencies {
  readonly invalidateRefs: (cwd: string) => Effect.Effect<void>;
  readonly run: Run;
  readonly withTemporaryIntentToAddIndex: TemporaryIndex;
  readonly withTemporarySelectedIndex: SelectedIndex;
  readonly generatedCommitMessage: (
    cwd: string,
    paths?: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<string, GitCommandError>;
  readonly generatedStashMessage: (
    cwd: string,
    mode: "all" | "staged" | "unstaged",
    paths: readonly string[],
  ) => Effect.Effect<string, GitCommandError>;
  readonly upstreamForRef: (
    cwd: string,
    refName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly refExists: (
    operation: string,
    cwd: string,
    refName: string,
  ) => Effect.Effect<boolean, GitCommandError>;
  readonly snapshot: SourceControlPanelService["Service"]["snapshot"];
  readonly workflow: GitWorkflowService["Service"];
}

const COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL =
  "The Git pre-commit hook could not load a required native dependency. Reinstall the repository dependencies and try again.";
const COMMIT_HOOK_FAILURE_DETAIL =
  "The Git pre-commit hook failed. Run the repository pre-commit hook in a terminal for details.";
const REVIEW_DIFF_PATCH_ARGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-relative",
  "--unified=3",
  "--inter-hunk-context=0",
] as const;
const REVIEW_DIFF_MINIMAL_PATCH_ARGS = [...REVIEW_DIFF_PATCH_ARGS, "--minimal"] as const;
type CommitFailureHint = "hook-failed" | "native-dependency";

function commitFailureHintFromOutputLine(line: string): CommitFailureHint | null {
  if (
    line.includes("Cannot find native binding") ||
    line.includes("Cannot find module 'vite-plus/binding'") ||
    line.includes('Cannot find module "vite-plus/binding"')
  )
    return "native-dependency";
  return line.includes("VITE+ - pre-commit script failed") ? "hook-failed" : null;
}

function commitFailureDetail(hint: CommitFailureHint | null): string | null {
  return hint === "native-dependency"
    ? COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL
    : hint === "hook-failed"
      ? COMMIT_HOOK_FAILURE_DETAIL
      : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function gitError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
) {
  return new GitCommandError({
    operation,
    cwd,
    command: commandLabel(args),
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

const isGitCommandError = Schema.is(GitCommandError);

function asGitCommandError(operation: string, cwd: string, args: readonly string[]) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : gitError(operation, cwd, args, "Git command failed.", sanitizeErrorCause(cause));
}

function validateGitPositionalName(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: string;
  readonly value: string;
}): Effect.Effect<string, GitCommandError> {
  const value = input.value.trim();
  if (value.length === 0)
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} is required.`),
    );
  if (value.startsWith("-"))
    return Effect.fail(
      gitError(input.operation, input.cwd, input.args, `${input.kind} cannot start with "-".`),
    );
  return Effect.succeed(value);
}

function targetRef(target: VcsPanelCompareInput["left"]): string {
  switch (target.kind) {
    case "working-tree":
      return "";
    case "branch":
      return target.refName;
    case "stash":
      return target.refName;
  }
}

function resolveRemoteBranchRef(refName: string, remoteNamesByLength: readonly string[]) {
  return parseRemoteRefWithRemoteNames(refName, remoteNamesByLength);
}

export function makeSourceControlPanelActions(
  deps: SourceControlPanelActionDependencies,
): Pick<SourceControlPanelService["Service"], SourceControlPanelActionMethodName> {
  const {
    generatedCommitMessage,
    generatedStashMessage,
    invalidateRefs,
    refExists,
    run,
    snapshot,
    upstreamForRef,
    withTemporaryIntentToAddIndex,
    withTemporarySelectedIndex,
    workflow,
  } = deps;
  const withRefInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => effect.pipe(Effect.ensuring(invalidateRefs(cwd)));
  const stageFiles: SourceControlPanelService["Service"]["stageFiles"] = (input) =>
    run("vcs.panel.stageFiles", input.cwd, [
      "--literal-pathspecs",
      "add",
      "-A",
      "--",
      ...input.paths,
    ]).pipe(Effect.asVoid);

  const unstageFiles: SourceControlPanelService["Service"]["unstageFiles"] = (input) =>
    run("vcs.panel.unstageFiles", input.cwd, [
      "--literal-pathspecs",
      "reset",
      "--",
      ...input.paths,
    ]).pipe(Effect.asVoid);

  const discardFiles: SourceControlPanelService["Service"]["discardFiles"] = (input) =>
    Effect.gen(function* () {
      const paths = uniquePaths(input.paths);
      if (paths.length === 0) return;
      if (input.staged) {
        const headPaths = yield* run(
          "vcs.panel.discardStagedFiles.listHeadPaths",
          input.cwd,
          ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "HEAD", "--", ...paths],
          { allowNonZeroExit: true },
        ).pipe(Effect.map(parsePathLines));
        const headPathSet = new Set(headPaths);
        const pathsInHead = paths.filter((path) => headPathSet.has(path));
        const pathsOutsideHead = paths.filter((path) => !headPathSet.has(path));

        if (pathsInHead.length > 0) {
          yield* run("vcs.panel.discardStagedFiles", input.cwd, [
            "--literal-pathspecs",
            "restore",
            "--staged",
            "--worktree",
            "--source=HEAD",
            "--",
            ...pathsInHead,
          ]).pipe(Effect.asVoid);
        }
        if (pathsOutsideHead.length > 0) {
          yield* run("vcs.panel.discardStagedFiles.reset", input.cwd, [
            "--literal-pathspecs",
            "reset",
            "--",
            ...pathsOutsideHead,
          ]).pipe(Effect.asVoid);
          yield* run("vcs.panel.discardStagedFiles.clean", input.cwd, [
            "--literal-pathspecs",
            "clean",
            "-fd",
            "--",
            ...pathsOutsideHead,
          ]).pipe(Effect.asVoid);
        }
        return;
      }

      const trackedPaths = yield* run("vcs.panel.discardUnstagedFiles.listIndexPaths", input.cwd, [
        "--literal-pathspecs",
        "ls-files",
        "--cached",
        "--",
        ...paths,
      ]).pipe(Effect.map(parsePathLines));
      if (trackedPaths.length > 0) {
        yield* run("vcs.panel.discardUnstagedFiles", input.cwd, [
          "--literal-pathspecs",
          "restore",
          "--worktree",
          "--",
          ...trackedPaths,
        ]).pipe(Effect.asVoid);
      }
      yield* run("vcs.panel.cleanUntrackedFiles", input.cwd, [
        "--literal-pathspecs",
        "clean",
        "-fd",
        "--",
        ...paths,
      ]).pipe(Effect.asVoid);
    });

  const readFileDiff: SourceControlPanelService["Service"]["readFileDiff"] = Effect.fn(
    "readFileDiff",
  )(function* (input) {
    const source = input.source ?? {
      kind: "working-tree" as const,
      staged: input.staged ?? false,
    };
    const diffPaths = uniquePaths(
      input.originalPath ? [input.originalPath, input.path] : [input.path],
    );
    if (source.kind === "commit") {
      const patch = yield* run("vcs.panel.readCommitFileDiff", input.cwd, [
        "show",
        "--format=",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        source.sha,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "compare") {
      const patch = yield* run("vcs.panel.readCompareFileDiff", input.cwd, [
        "diff",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        `${source.baseRef}...${source.refName}`,
        "--",
        ...diffPaths,
      ]);
      return { path: input.path, staged: false, patch };
    }
    if (source.kind === "stash") {
      let patch = yield* run("vcs.panel.readStashFileDiff", input.cwd, [
        "diff",
        ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
        "--find-renames=20%",
        `${source.stashRef}^1`,
        source.stashRef,
        "--",
        ...diffPaths,
      ]);
      if (patch.trim().length === 0) {
        patch = yield* run(
          "vcs.panel.readStashUntrackedFileDiff",
          input.cwd,
          [
            "show",
            "--format=",
            ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
            `${source.stashRef}^3`,
            "--",
            ...diffPaths,
          ],
          { allowNonZeroExit: true },
        );
      }
      return { path: input.path, staged: false, patch };
    }

    const args = source.staged
      ? [
          "diff",
          "--cached",
          ...REVIEW_DIFF_MINIMAL_PATCH_ARGS,
          "--find-renames=20%",
          "--",
          ...diffPaths,
        ]
      : ["diff", ...REVIEW_DIFF_MINIMAL_PATCH_ARGS, "--find-renames=20%", "--", ...diffPaths];
    let patch =
      !source.staged && input.originalPath
        ? yield* withTemporaryIntentToAddIndex(
            {
              cwd: input.cwd,
              paths: [input.path],
              operations: {
                gitIndexPath: "vcs.panel.readFileDiff.gitIndexPath",
                tempIndexReadTree: "vcs.panel.readFileDiff.tempIndexReadTree",
                tempIndexIntentToAdd: "vcs.panel.readFileDiff.tempIndexIntentToAdd",
              },
            },
            (env) => run("vcs.panel.readFileDiff", input.cwd, args, { env }),
          ).pipe(Effect.catch(() => run("vcs.panel.readFileDiff", input.cwd, args)))
        : yield* run("vcs.panel.readFileDiff", input.cwd, args);
    if (!source.staged && !input.originalPath && patch.trim().length === 0) {
      patch = yield* run(
        "vcs.panel.readUntrackedFileDiff",
        input.cwd,
        ["diff", "--no-index", ...REVIEW_DIFF_PATCH_ARGS, "--", "/dev/null", input.path],
        { allowNonZeroExit: true },
      );
    }
    return { path: input.path, staged: source.staged, patch };
  });

  const pushBranchDirect = Effect.fn("pushBranchDirect")(function* (
    cwd: string,
    branchName: string,
    force: boolean,
    publishRemoteName?: string,
  ) {
    const upstream = publishRemoteName ? "" : ((yield* upstreamForRef(cwd, branchName)) ?? "");
    const remoteNames =
      upstream.length > 0
        ? yield* run("vcs.panel.pushBranch.remotes", cwd, ["remote"]).pipe(
            Effect.map(parseRemoteNames),
            Effect.orElseSucceed((): readonly string[] => []),
          )
        : [];
    const parsedUpstream =
      upstream.length > 0 ? parseRemoteRefWithRemoteNames(upstream, remoteNames) : null;
    const fallbackUpstreamParts = parsedUpstream ? [] : upstream.split("/");
    const upstreamRemoteName = parsedUpstream?.remoteName ?? fallbackUpstreamParts[0] ?? "origin";
    const upstreamBranchName =
      (parsedUpstream?.branchName ?? fallbackUpstreamParts.slice(1).join("/")) || branchName;
    const hasSameNameUpstream = upstream.length > 0 && upstreamBranchName === branchName;
    const remoteName = publishRemoteName ?? (hasSameNameUpstream ? upstreamRemoteName : "origin");
    const remoteBranchName = hasSameNameUpstream ? upstreamBranchName : branchName;
    yield* run("vcs.panel.pushBranch", cwd, [
      "push",
      ...(force ? ["--force-with-lease"] : []),
      "-u",
      remoteName,
      `${branchName}:refs/heads/${remoteBranchName}`,
    ]).pipe(Effect.asVoid);
  });

  const runCommit = Effect.fn("runCommit")(function* (
    cwd: string,
    message: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const args = ["commit", "-m", message] as const;
    let failureHint: CommitFailureHint | null = null;
    const recordFailureHint = (line: string) =>
      Effect.sync(() => {
        const nextHint = commitFailureHintFromOutputLine(line);
        if (nextHint !== null && (nextHint === "native-dependency" || failureHint === null)) {
          failureHint = nextHint;
        }
      });

    yield* run("vcs.panel.commitStaged", cwd, args, {
      ...(env === undefined ? {} : { env }),
      progress: {
        onStdoutLine: recordFailureHint,
        onStderrLine: recordFailureHint,
      },
    }).pipe(
      Effect.mapError((error) => {
        const detail = commitFailureDetail(failureHint);
        return detail === null
          ? error
          : gitError("vcs.panel.commitStaged", cwd, args, detail, error);
      }),
      Effect.asVoid,
    );
  });

  const commitStaged: SourceControlPanelService["Service"]["commitStaged"] = Effect.fn(
    "commitStaged",
  )(function* (input) {
    const paths = uniquePaths(input.paths ?? []);
    if (paths.length > 0) {
      yield* withTemporarySelectedIndex(input.cwd, paths, (env) =>
        Effect.gen(function* () {
          const message =
            input.message?.trim() || (yield* generatedCommitMessage(input.cwd, paths, env));
          yield* runCommit(input.cwd, message, env);
        }),
      );
      const indexSyncExit = yield* Effect.exit(stageFiles({ cwd: input.cwd, paths }));
      if (Exit.isFailure(indexSyncExit)) {
        yield* Effect.logWarning("Selected-file commit index synchronization failed after commit", {
          cwd: input.cwd,
          pathCount: paths.length,
          cause: indexSyncExit.cause,
        });
      }
    } else {
      const message = input.message?.trim() || (yield* generatedCommitMessage(input.cwd));
      yield* runCommit(input.cwd, message);
    }
    if (input.push) {
      const status = yield* workflow
        .status({ cwd: input.cwd })
        .pipe(
          Effect.mapError(
            asGitCommandError("vcs.panel.commitStaged.status", input.cwd, ["status"]),
          ),
        );
      if (!status.refName) {
        return yield* gitError(
          "vcs.panel.commitStaged.push",
          input.cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }
      yield* pushBranchDirect(input.cwd, status.refName, false);
    }
  });

  const pullBranch: SourceControlPanelService["Service"]["pullBranch"] = Effect.fn("pullBranch")(
    function* (input) {
      const status = yield* workflow
        .status({ cwd: input.cwd })
        .pipe(
          Effect.mapError(asGitCommandError("vcs.panel.pullBranch.status", input.cwd, ["status"])),
        );
      if (status.refName !== input.branchName) {
        if (input.merge) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull", "--no-rebase"],
            "Merge sync is only available for the current branch.",
          );
        }
        const upstream = yield* upstreamForRef(input.cwd, input.branchName);
        if (!upstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has no upstream.`,
          );
        }
        const remoteOutput = yield* run("vcs.panel.pullBranch.remotes", input.cwd, ["remote"]);
        const resolvedUpstream = resolveRemoteBranchRef(upstream, parseRemoteNames(remoteOutput));
        if (!resolvedUpstream) {
          return yield* gitError(
            "vcs.panel.pullBranch",
            input.cwd,
            ["pull"],
            `Branch ${input.branchName} has invalid upstream ${upstream}.`,
          );
        }
        yield* run("vcs.panel.pullBranch.nonCurrent", input.cwd, [
          "fetch",
          resolvedUpstream.remoteName,
          `${input.force ? "+" : ""}refs/heads/${resolvedUpstream.branchName}:refs/heads/${input.branchName}`,
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.force) {
        yield* run("vcs.panel.forcePullBranch", input.cwd, ["fetch"]);
        const upstream = yield* run("vcs.panel.forcePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.forcePullBranch.reset", input.cwd, [
          "reset",
          "--hard",
          upstream,
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      if (input.merge) {
        const upstream = yield* run("vcs.panel.mergePullBranch.upstream", input.cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).pipe(Effect.map((value) => value.trim()));
        yield* run("vcs.panel.mergePullBranch", input.cwd, [
          "pull",
          "--no-rebase",
          "--no-edit",
        ]).pipe(Effect.asVoid);
        return {
          status: "pulled" as const,
          refName: input.branchName,
          upstreamRef: upstream,
        };
      }
      return yield* workflow.pullCurrentBranch(input.cwd);
    },
  );

  const pushBranch: SourceControlPanelService["Service"]["pushBranch"] = Effect.fn("pushBranch")(
    function* (input) {
      yield* pushBranchDirect(input.cwd, input.branchName, input.force ?? false, input.remoteName);
    },
  );

  const fetchBranch: SourceControlPanelService["Service"]["fetchBranch"] = Effect.fn("fetchBranch")(
    function* (input) {
      const remoteOutput = yield* run("vcs.panel.fetchBranch.remotes", input.cwd, ["remote"]);
      const gitOrderRemoteNames = parseRemoteNamesInGitOrder(remoteOutput);
      const sortedRemoteNames = parseRemoteNames(remoteOutput);
      // Local branches intentionally win over same-named remote refs.
      const isLocalBranch = yield* refExists(
        "vcs.panel.fetchBranch.localBranch",
        input.cwd,
        `refs/heads/${input.branchName}`,
      );
      const parsedRemoteBranch = isLocalBranch
        ? null
        : parseRemoteRefWithRemoteNames(input.branchName, sortedRemoteNames);
      const isRemoteBranch = parsedRemoteBranch
        ? yield* refExists(
            "vcs.panel.fetchBranch.remoteBranch",
            input.cwd,
            `refs/remotes/${parsedRemoteBranch.remoteRef}`,
          )
        : false;
      const upstream =
        isRemoteBranch && parsedRemoteBranch
          ? parsedRemoteBranch.remoteRef
          : yield* upstreamForRef(input.cwd, input.branchName);
      const resolvedUpstream = upstream
        ? resolveRemoteBranchRef(upstream, sortedRemoteNames)
        : null;
      if (upstream && !resolvedUpstream) {
        return yield* gitError(
          "vcs.panel.fetchBranch",
          input.cwd,
          ["fetch"],
          `Branch ${input.branchName} has invalid upstream ${upstream}.`,
        );
      }
      const remoteName = resolvedUpstream?.remoteName ?? gitOrderRemoteNames[0] ?? "origin";
      const remoteBranchName = resolvedUpstream?.branchName ?? input.branchName;
      yield* run("vcs.panel.fetchBranch", input.cwd, [
        "fetch",
        remoteName,
        `refs/heads/${remoteBranchName}:refs/remotes/${remoteName}/${remoteBranchName}`,
      ]).pipe(Effect.asVoid);
    },
  );

  const deleteBranch: SourceControlPanelService["Service"]["deleteBranch"] = Effect.fn(
    "deleteBranch",
  )(function* (input) {
    const panelSnapshot = yield* snapshot({ cwd: input.cwd });
    const localBranch = panelSnapshot.localBranches.find(
      (branch) => branch.name === input.branchName,
    );
    if (localBranch?.current) {
      return yield* gitError(
        "vcs.panel.deleteBranch",
        input.cwd,
        ["branch", "-d", input.branchName],
        "Cannot delete the current branch.",
      );
    }
    if (localBranch?.worktreePath) {
      return yield* gitError(
        "vcs.panel.deleteBranch",
        input.cwd,
        ["branch", "-d", input.branchName],
        "Cannot delete a branch that is checked out in another worktree.",
      );
    }
    if (localBranch) {
      yield* run("vcs.panel.deleteLocalBranch", input.cwd, [
        "branch",
        input.force ? "-D" : "-d",
        input.branchName,
      ]).pipe(Effect.asVoid);
      return;
    }
    const remoteBranch = panelSnapshot.remotes.flatMap((remote) =>
      remote.branches
        .filter(
          (branch) =>
            branch.fullRefName === input.branchName ||
            `${remote.name}/${branch.name}` === input.branchName,
        )
        .map((branch) => ({ remoteName: remote.name, branchName: branch.name })),
    )[0];
    if (remoteBranch) {
      yield* run("vcs.panel.deleteRemoteBranch", input.cwd, [
        "push",
        remoteBranch.remoteName,
        "--delete",
        remoteBranch.branchName,
      ]).pipe(Effect.asVoid);
      return;
    }
    return yield* gitError(
      "vcs.panel.deleteBranch",
      input.cwd,
      ["branch", input.force ? "-D" : "-d", input.branchName],
      `Branch ${input.branchName} was not found in the current source-control snapshot.`,
    );
  });

  const undoLatestCommit: SourceControlPanelService["Service"]["undoLatestCommit"] = Effect.fn(
    "undoLatestCommit",
  )(function* (input) {
    const currentBranch = yield* run("vcs.panel.currentBranch", input.cwd, [
      "branch",
      "--show-current",
    ]).pipe(Effect.map((branch) => branch.trim()));
    const targetBranch = input.branchName ?? currentBranch;
    const resetTarget = input.sha ? `${input.sha}^` : `${targetBranch || "HEAD"}~1`;

    if (!targetBranch || targetBranch === currentBranch) {
      yield* run("vcs.panel.undoLatestCommit", input.cwd, ["reset", "--soft", resetTarget]).pipe(
        Effect.asVoid,
      );
      return;
    }

    yield* run("vcs.panel.undoBranchCommit", input.cwd, [
      "branch",
      "-f",
      targetBranch,
      resetTarget,
    ]).pipe(Effect.asVoid);
  });

  const revertCommit: SourceControlPanelService["Service"]["revertCommit"] = (input) =>
    run("vcs.panel.revertCommit", input.cwd, ["revert", "--no-edit", input.sha]).pipe(
      Effect.asVoid,
    );

  const checkoutCommit: SourceControlPanelService["Service"]["checkoutCommit"] = Effect.fn(
    "checkoutCommit",
  )(function* (input) {
    yield* run("vcs.panel.checkoutCommit", input.cwd, ["checkout", "--detach", input.sha]).pipe(
      Effect.asVoid,
    );
    return { refName: input.sha };
  });

  const createBranchFromCommit: SourceControlPanelService["Service"]["createBranchFromCommit"] =
    Effect.fn("createBranchFromCommit")(function* (input) {
      const branchName = yield* validateGitPositionalName({
        operation: "vcs.panel.createBranchFromCommit",
        cwd: input.cwd,
        args: ["branch", "<name>", input.sha],
        kind: "Branch name",
        value: input.branchName ?? "",
      });
      yield* withRefInvalidation(
        input.cwd,
        run("vcs.panel.createBranchFromCommit", input.cwd, [
          "branch",
          "--",
          branchName,
          input.sha,
        ]).pipe(Effect.asVoid),
      );
      return { refName: branchName };
    });

  const mergeBranchIntoCurrent: SourceControlPanelService["Service"]["mergeBranchIntoCurrent"] = (
    input,
  ) =>
    run("vcs.panel.mergeBranchIntoCurrent", input.cwd, [
      "merge",
      "--no-edit",
      "--",
      input.refName,
    ]).pipe(Effect.asVoid);

  const rebaseCurrentOnto: SourceControlPanelService["Service"]["rebaseCurrentOnto"] = (input) =>
    run("vcs.panel.rebaseCurrentOnto", input.cwd, ["rebase", "--", input.refName]).pipe(
      Effect.asVoid,
    );

  const refAffectingActions = {
    commitStaged: (input) => withRefInvalidation(input.cwd, commitStaged(input)),
    pullBranch: (input) => withRefInvalidation(input.cwd, pullBranch(input)),
    pushBranch: (input) => withRefInvalidation(input.cwd, pushBranch(input)),
    deleteBranch: (input) => withRefInvalidation(input.cwd, deleteBranch(input)),
    undoLatestCommit: (input) => withRefInvalidation(input.cwd, undoLatestCommit(input)),
    revertCommit: (input) => withRefInvalidation(input.cwd, revertCommit(input)),
    checkoutCommit: (input) => withRefInvalidation(input.cwd, checkoutCommit(input)),
    createBranchFromCommit,
    mergeBranchIntoCurrent: (input) =>
      withRefInvalidation(input.cwd, mergeBranchIntoCurrent(input)),
    rebaseCurrentOnto: (input) => withRefInvalidation(input.cwd, rebaseCurrentOnto(input)),
    fetchBranch: (input) => withRefInvalidation(input.cwd, fetchBranch(input)),
    fetchRemote: (input) =>
      withRefInvalidation(
        input.cwd,
        run("vcs.panel.fetchRemote", input.cwd, ["fetch", input.remoteName]).pipe(Effect.asVoid),
      ),
    addRemote: Effect.fn("addRemote")(function* (input) {
      const remoteName = yield* validateGitPositionalName({
        operation: "vcs.panel.addRemote",
        cwd: input.cwd,
        args: ["remote", "add", "<name>", input.url],
        kind: "Remote name",
        value: input.name,
      });
      yield* withRefInvalidation(
        input.cwd,
        run("vcs.panel.addRemote", input.cwd, ["remote", "add", remoteName, input.url]).pipe(
          Effect.asVoid,
        ),
      );
    }),
    removeRemote: Effect.fn("removeRemote")(function* (input) {
      const remoteName = yield* validateGitPositionalName({
        operation: "vcs.panel.removeRemote",
        cwd: input.cwd,
        args: ["remote", "remove", "<name>"],
        kind: "Remote name",
        value: input.remoteName,
      });
      yield* withRefInvalidation(
        input.cwd,
        run("vcs.panel.removeRemote", input.cwd, ["remote", "remove", remoteName]).pipe(
          Effect.asVoid,
        ),
      );
    }),
  } satisfies Pick<
    SourceControlPanelService["Service"],
    (typeof SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS)[number]
  >;

  return {
    stageFiles,
    unstageFiles,
    discardFiles,
    readFileDiff,
    ...refAffectingActions,
    createStash: (input) => {
      const mode = input.mode ?? "all";
      const modeArgs =
        mode === "staged"
          ? ["--staged"]
          : mode === "unstaged" || input.includeUntracked
            ? ["--include-untracked", ...(mode === "unstaged" ? ["--keep-index"] : [])]
            : [];
      return Effect.gen(function* () {
        const paths = input.paths ?? [];
        const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
        const message =
          input.message?.trim() || (yield* generatedStashMessage(input.cwd, mode, paths));
        yield* run("vcs.panel.createStash", input.cwd, [
          ...(paths.length > 0 ? ["--literal-pathspecs"] : []),
          "stash",
          "push",
          ...modeArgs,
          "-m",
          message,
          ...pathArgs,
        ]).pipe(Effect.asVoid);
      });
    },
    applyStash: (input) =>
      run("vcs.panel.applyStash", input.cwd, [
        "stash",
        "apply",
        input.stashRef ?? "stash@{0}",
      ]).pipe(Effect.asVoid),
    popStash: (input) =>
      run("vcs.panel.popStash", input.cwd, ["stash", "pop", input.stashRef ?? "stash@{0}"]).pipe(
        Effect.asVoid,
      ),
    dropStash: (input) =>
      run("vcs.panel.dropStash", input.cwd, ["stash", "drop", input.stashRef ?? "stash@{0}"]).pipe(
        Effect.asVoid,
      ),
    compare: (input) => {
      const left = targetRef(input.left);
      const right = targetRef(input.right);
      const range = left && right ? `${left}..${right}` : left || right;
      const reverse = input.left.kind === "working-tree" && input.right.kind !== "working-tree";
      const args = range
        ? ["diff", ...REVIEW_DIFF_MINIMAL_PATCH_ARGS, ...(reverse ? ["--reverse"] : []), range]
        : ["diff", ...REVIEW_DIFF_PATCH_ARGS];
      return run("vcs.panel.compare", input.cwd, args).pipe(
        Effect.map((patch): VcsPanelCompareResult => ({ patch })),
      );
    },
  };
}
