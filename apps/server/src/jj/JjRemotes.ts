import * as Effect from "effect/Effect";

import { GitCommandError, type VcsPullResult } from "@t3tools/contracts";
import { normalizeGitRemoteUrl, resolveAutoFeatureBranchName } from "@t3tools/shared/git";

import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import { classifyGitFailure, STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import {
  bookmarkNameArgument,
  exactStringPattern,
  localBookmarkRevset,
  remoteBookmarkRevset,
  splitRemoteRefName,
} from "../vcs/JjRevset.ts";
import type { JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import {
  computeAheadBehindCounts,
  resolveWorkspaceRefName,
  resolveUpstreamContext,
} from "./JjStatus.ts";
import { isT3WorkspaceName } from "./JjWorkspaces.ts";

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;

/** jj stderr is the only place the real reason lives; bound it the way the git path bounds its own. */
const STDERR_DETAIL_MAX_CHARS = 500;

function boundedStderr(stderr: string): string {
  return stderr.trim().slice(0, STDERR_DETAIL_MAX_CHARS);
}

interface PrivateRemoteRef {
  readonly ref: string;
  readonly oid: string;
}

const capturePrivateRemoteRefs = Effect.fn("JjRemotes.capturePrivateRemoteRefs")(function* (
  process: VcsProcess.VcsProcess["Service"],
  paths: JjProcess.ColocatedGitInput,
  operation: string,
  remoteName: string,
  bookmark?: string,
) {
  const prefix = `refs/t3/remotes/${encodeURIComponent(remoteName)}/`;
  const target = bookmark === undefined ? prefix : `${prefix}${bookmark}`;
  const result = yield* JjProcess.colocatedGitCommand(
    process,
    operation,
    paths,
    ["for-each-ref", "--format=%(refname) %(objectname)", target],
    { timeoutMs: 10_000 },
  ).pipe(mapJjFailure(operation, paths.cwd, "Could not read background remote refs."));
  const refs: PrivateRemoteRef[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    const [ref, oid] = line.split(" ");
    if (ref && oid && (bookmark === undefined ? ref.startsWith(prefix) : ref === target)) {
      refs.push({ ref, oid });
    }
  }
  return refs;
});

const deleteCapturedPrivateRemoteRefs = Effect.fn("JjRemotes.deleteCapturedPrivateRemoteRefs")(
  function* (
    process: VcsProcess.VcsProcess["Service"],
    paths: JjProcess.ColocatedGitInput,
    operation: string,
    refs: ReadonlyArray<PrivateRemoteRef>,
  ) {
    for (const { ref, oid } of refs) {
      const result = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        paths,
        ["update-ref", "-d", ref, oid],
        { allowNonZeroExit: true, timeoutMs: 10_000 },
      ).pipe(mapJjFailure(operation, paths.cwd, "Could not clear background remote refs."));
      // Keep a background fetch that won the race; never delete a ref we did not capture.
      const compareFailed =
        (result.stderr.includes(`cannot lock ref '${ref}': is at `) &&
          result.stderr.includes(`but expected ${oid}`)) ||
        result.stderr.includes(
          `cannot lock ref '${ref}': reference is missing but expected ${oid}`,
        );
      if (result.exitCode !== 0 && !compareFailed) {
        return yield* Effect.fail(
          new GitCommandError({
            operation,
            command: "git",
            cwd: paths.cwd,
            detail: boundedStderr(result.stderr) || "Could not clear background remote refs.",
          }),
        );
      }
    }
  },
);

/**
 * A conflicted bookmark cannot be used as a revset symbol, and `jj bookmark set` on one silently
 * resolves the conflict by discarding a side. The guard lives beside `bookmarkTo`, its most
 * dangerous caller, so no call site can forget it.
 */
export const assertBookmarkUsable = Effect.fn("JjRemotes.assertBookmarkUsable")(function* (
  driver: JjVcsDriverShape,
  operation: string,
  cwd: string,
  name: string,
): Effect.fn.Return<void, GitCommandError> {
  const bookmarks = yield* driver
    .listBookmarks(cwd)
    .pipe(mapJjFailure(operation, cwd, "Could not list Jujutsu bookmarks."));
  const conflicted = bookmarks.some(
    (bookmark) => bookmark.name === name && bookmark.remote === null && bookmark.conflict,
  );
  if (conflicted) {
    return yield* Effect.fail(
      jjFailure(
        operation,
        cwd,
        `Bookmark ${name} is conflicted. Resolve it with \`jj bookmark set ${name} -r <revision>\` before using it here.`,
      ),
    );
  }
});

/**
 * jj keeps no upstream metadata in git's branch config, so the git-side pull-request machinery
 * never probes owner-qualified heads and misses fork PRs. These two keys are inert to jj and make
 * it behave exactly as it does for a git checkout.
 */
export const writeBookmarkUpstreamConfig = Effect.fn("JjRemotes.writeBookmarkUpstreamConfig")(
  function* (
    process: VcsProcess.VcsProcess["Service"],
    input: {
      readonly gitDir: string | null;
      readonly cwd: string;
      readonly name: string;
      readonly remoteName: string;
      readonly remoteBranch?: string;
      readonly importedPullRequest?: boolean;
    },
  ): Effect.fn.Return<void, never> {
    const gitDir = input.gitDir;
    if (gitDir === null) {
      return;
    }
    const write = (key: string, value: string) =>
      JjProcess.colocatedGitCommand(
        process,
        "JjRemotes.writeBookmarkUpstreamConfig",
        { gitDir, cwd: input.cwd },
        ["config", key, value],
        { allowNonZeroExit: true, timeoutMs: 10_000 },
      ).pipe(Effect.ignore);

    yield* write(`branch.${input.name}.remote`, input.remoteName);
    yield* write(`branch.${input.name}.merge`, `refs/heads/${input.remoteBranch ?? input.name}`);
    if (input.importedPullRequest) {
      yield* write(`branch.${input.name}.t3code-imported-pr-head`, "true");
    }
  },
);

/** `jj bookmark track <name> --remote=<remote>`, plus the git upstream config the hosting side reads. */
export const trackRemoteBookmark = Effect.fn("JjRemotes.trackRemoteBookmark")(function* (input: {
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly operation: string;
  readonly cwd: string;
  readonly gitDir: string | null;
  readonly remoteName: string;
  readonly name: string;
}): Effect.fn.Return<void, GitCommandError> {
  yield* JjProcess.jjCommand(
    input.process,
    input.operation,
    input.cwd,
    [
      "bookmark",
      "track",
      exactStringPattern(input.name),
      `--remote=${exactStringPattern(input.remoteName)}`,
    ],
    { allowNonZeroExit: true, timeoutMs: 20_000 },
  ).pipe(
    mapJjFailure(input.operation, input.cwd, `Could not track ${input.remoteName}/${input.name}.`),
  );

  yield* writeBookmarkUpstreamConfig(input.process, {
    gitDir: input.gitDir,
    cwd: input.cwd,
    name: input.name,
    remoteName: input.remoteName,
  });
});

export const ensureJjRemote = Effect.fn("JjRemotes.ensureJjRemote")(function* (input: {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly operation: string;
  readonly cwd: string;
  readonly remoteName: string;
  readonly remoteUrl: string;
}) {
  const existing = yield* input.driver
    .listRemotes(input.cwd)
    .pipe(mapJjFailure(input.operation, input.cwd, "Could not read this repository's remotes."));
  const normalizedTargetUrl = normalizeGitRemoteUrl(input.remoteUrl);
  const matchingRemote = existing.remotes.find(
    (remote) => normalizeGitRemoteUrl(remote.url) === normalizedTargetUrl,
  );
  const preferredName =
    input.remoteName
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fork";
  let remoteName = matchingRemote?.name ?? preferredName;
  if (matchingRemote === undefined) {
    let suffix = 1;
    while (existing.remotes.some((remote) => remote.name === remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }
    yield* JjProcess.jjCommand(
      input.process,
      input.operation,
      input.cwd,
      ["git", "remote", "add", remoteName, input.remoteUrl],
      { timeoutMs: 20_000 },
    ).pipe(mapJjFailure(input.operation, input.cwd, `Could not configure remote ${remoteName}.`));
    yield* input.driver.invalidateRepoCaches(input.cwd);
  }
  return remoteName;
});

export interface JjRemoteOpsDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
}

export interface JjBookmarkMoveInput {
  readonly cwd: string;
  readonly name: string;
  readonly revset: string;
  readonly operation: string;
  /** Commit/push must retain a feature tip when the workspace is editing its ancestor. */
  readonly preserveDescendants?: boolean;
}

export interface JjPublishResult {
  readonly refName: string;
  readonly remoteName: string;
  /**
   * `remote_added` mirrors the Git arm's partial success for a repository with no commits: the
   * remote is wired up and there is simply nothing to publish yet.
   */
  readonly status: "pushed" | "remote_added";
}

export interface JjPushResult {
  readonly status: "pushed" | "skipped_up_to_date";
  readonly refName: string;
}

export type JjRemoteOps = Pick<
  VcsWorkflowOps,
  | "fetchRemote"
  | "remoteExists"
  | "remoteBranchExists"
  | "resolveRemoteTrackingCommit"
  | "resolveWorktreeBaseRemote"
  | "fetchWorktreeBaseCommit"
> & {
  readonly requirePrimaryRemoteName: (
    operation: string,
    cwd: string,
  ) => Effect.Effect<string, GitCommandError>;
  /** Forward-only. `jj bookmark set` refuses a backwards or sideways move, so the guard runs first. */
  readonly bookmarkTo: (input: JjBookmarkMoveInput) => Effect.Effect<void, GitCommandError>;
  readonly pushBookmark: (input: {
    readonly cwd: string;
    readonly name: string;
    readonly remoteName: string;
    readonly operation: string;
    readonly pushFailureDetail?: (cause: GitCommandError, remoteName: string) => string;
  }) => Effect.Effect<JjPushResult, GitCommandError>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly publishRepository: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly remoteUrl: string;
    readonly pushFailureDetail?: (cause: GitCommandError, remoteName: string) => string;
  }) => Effect.Effect<JjPublishResult, GitCommandError>;
};

export const makeJjRemotes = (deps: JjRemoteOpsDeps): JjRemoteOps => {
  const { driver, process } = deps;

  const run = JjProcess.jjRunner(process);

  const requirePrimaryRemoteName = Effect.fn("JjRemotes.requirePrimaryRemoteName")(function* (
    operation: string,
    cwd: string,
  ): Effect.fn.Return<string, GitCommandError> {
    const remoteName = yield* driver
      .resolvePrimaryRemoteName(cwd)
      .pipe(mapJjFailure(operation, cwd, "Could not read this repository's remotes."));
    if (remoteName === null) {
      return yield* Effect.fail(
        jjFailure(operation, cwd, "Cannot resolve a remote for this repository."),
      );
    }
    return remoteName;
  });

  const fetchRemote: JjRemoteOps["fetchRemote"] = Effect.fn("JjRemotes.fetchRemote")(
    function* (input) {
      const bookmark =
        input.refName === undefined
          ? undefined
          : (splitRemoteRefName(input.refName, [input.remoteName])?.name ?? input.refName);
      const paths = yield* driver
        .ensureUsable("JjRemotes.fetchRemote", input.cwd)
        .pipe(
          mapJjFailure(
            "JjRemotes.fetchRemote",
            input.cwd,
            "Could not read this repository's paths.",
          ),
        );
      const gitPaths = { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot };
      const captured = yield* capturePrivateRemoteRefs(
        process,
        gitPaths,
        "JjRemotes.fetchRemote",
        input.remoteName,
      );
      yield* run(
        "JjRemotes.fetchRemote",
        input.cwd,
        [
          "git",
          "fetch",
          "--remote",
          exactStringPattern(input.remoteName),
          ...(bookmark === undefined ? [] : ["--branch", exactStringPattern(bookmark)]),
        ],
        { timeoutMs: FETCH_TIMEOUT_MS },
      ).pipe(
        mapJjFailure(
          "JjRemotes.fetchRemote",
          input.cwd,
          `Could not fetch from ${input.remoteName}.`,
        ),
      );
      yield* driver.invalidateRepoCaches(input.cwd);
      yield* deleteCapturedPrivateRemoteRefs(process, gitPaths, "JjRemotes.fetchRemote", captured);
    },
  );

  const remoteExists: JjRemoteOps["remoteExists"] = (input) =>
    driver.listRemoteNames(input.cwd).pipe(
      Effect.map((names) => names.includes(input.remoteName)),
      mapJjFailure(
        "JjRemotes.remoteExists",
        input.cwd,
        "Could not read this repository's remotes.",
      ),
    );

  const remoteBranchExists: JjRemoteOps["remoteBranchExists"] = (input) =>
    driver.listBookmarks(input.cwd).pipe(
      Effect.map((bookmarks) =>
        bookmarks.some(
          (bookmark) => bookmark.name === input.refName && bookmark.remote === input.remoteName,
        ),
      ),
      mapJjFailure("JjRemotes.remoteBranchExists", input.cwd, "Could not list Jujutsu bookmarks."),
    );

  const resolveRemoteTrackingCommit: JjRemoteOps["resolveRemoteTrackingCommit"] = Effect.fn(
    "JjRemotes.resolveRemoteTrackingCommit",
  )(function* (input) {
    const operation = "JjRemotes.resolveRemoteTrackingCommit";
    const remoteNames = yield* driver
      .listRemoteNames(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's remotes."));
    const split = splitRemoteRefName(input.refName, remoteNames);
    const remoteName = split?.remote ?? input.fallbackRemoteName;
    const name = split?.name ?? input.refName;

    const change = yield* driver
      .changeAt(input.cwd, remoteBookmarkRevset(remoteName, name))
      .pipe(mapJjFailure(operation, input.cwd, "Could not resolve the remote bookmark."));
    if (change === null) {
      return yield* Effect.fail(
        jjFailure(operation, input.cwd, `${remoteName}/${name} does not exist on the remote.`),
      );
    }
    return { commitSha: change.commitId, remoteRefName: `${remoteName}/${name}` };
  });

  const resolveWorktreeBaseRemote: JjRemoteOps["resolveWorktreeBaseRemote"] = Effect.fn(
    "JjRemotes.resolveWorktreeBaseRemote",
  )(function* (input) {
    const operation = "JjRemotes.resolveWorktreeBaseRemote";
    const remoteNames = yield* driver
      .listRemoteNames(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's remotes."));
    const bookmarks = yield* driver
      .listBookmarks(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
    const local = bookmarks.some(
      (bookmark) => bookmark.name === input.refName && bookmark.remote === null,
    );
    // A local bookmark shadows a remote-qualified name, just as a local Git branch does.
    const tracked = local
      ? bookmarks.filter(
          (bookmark) =>
            bookmark.name === input.refName &&
            bookmark.remote !== null &&
            bookmark.tracked &&
            remoteNames.includes(bookmark.remote),
        )
      : [];
    const upstream = tracked.find((bookmark) => bookmark.remote === "origin") ?? tracked[0];
    const explicit = local ? null : splitRemoteRefName(input.refName, remoteNames);
    const remoteName = upstream?.remote ?? explicit?.remote ?? "origin";
    const branchName = explicit?.name ?? input.refName;
    return remoteNames.includes(remoteName) ? { remoteName, branchName } : null;
  });

  const fetchWorktreeBaseCommit: JjRemoteOps["fetchWorktreeBaseCommit"] = Effect.fn(
    "JjRemotes.fetchWorktreeBaseCommit",
  )(function* (input) {
    const operation = "JjRemotes.fetchWorktreeBaseCommit";
    const target = yield* resolveWorktreeBaseRemote(input);
    if (target === null) return null;
    const { remoteName, branchName } = target;
    const paths = yield* driver
      .ensureUsable(operation, input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's paths."));
    // A scoped jj fetch can leave a deleted remote bookmark cached. Check the actual remote,
    // not a local bookmark or private background-fetch ref, before resolving its target.
    const advertised = yield* JjProcess.colocatedGitCommand(
      process,
      operation,
      { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
      ["ls-remote", "--exit-code", "--heads", "--", remoteName, `refs/heads/${branchName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        env: STATUS_UPSTREAM_REFRESH_ENV,
      },
    ).pipe(mapJjFailure(operation, input.cwd, "Could not read the remote bookmark."));
    if (advertised.exitCode === 2) return null;
    if (advertised.exitCode !== 0) {
      return yield* Effect.fail(
        jjFailure(
          operation,
          input.cwd,
          boundedStderr(advertised.stderr) || "Could not read the remote bookmark.",
        ),
      );
    }
    yield* fetchRemote({ cwd: input.cwd, remoteName, refName: `${remoteName}/${branchName}` });
    const change = yield* driver
      .changeAt(input.cwd, remoteBookmarkRevset(remoteName, branchName))
      .pipe(mapJjFailure(operation, input.cwd, "Could not resolve the remote bookmark."));
    return change === null
      ? null
      : { commitSha: change.commitId, remoteRefName: `${remoteName}/${branchName}` };
  });

  const bookmarkTo: JjRemoteOps["bookmarkTo"] = Effect.fn("JjRemotes.bookmarkTo")(
    function* (input) {
      yield* assertBookmarkUsable(driver, input.operation, input.cwd, input.name);

      const bookmarks = yield* driver
        .listBookmarks(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not list Jujutsu bookmarks."));
      const existing = bookmarks.find(
        (bookmark) => bookmark.name === input.name && bookmark.remote === null,
      );

      if (existing === undefined) {
        yield* run(
          input.operation,
          input.cwd,
          ["bookmark", "create", bookmarkNameArgument(input.name), "-r", input.revset],
          { timeoutMs: 20_000 },
        ).pipe(
          mapJjFailure(input.operation, input.cwd, `Could not create bookmark ${input.name}.`),
        );
        yield* driver.invalidateRepoCaches(input.cwd);
        return;
      }

      const target = yield* driver
        .changeAt(input.cwd, input.revset)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not resolve the target revision."));
      if (target !== null && existing.target === target.commitId) {
        return;
      }
      if (
        input.preserveDescendants &&
        (yield* driver
          .countRevset(input.cwd, `(${input.revset}) & ::${localBookmarkRevset(input.name)}`)
          .pipe(mapJjFailure(input.operation, input.cwd, "Could not compare bookmark ancestry."))) >
          0
      )
        return;

      // An ancestry test, not a range: `A..B` is non-empty for siblings too, so a range would
      // authorise a sideways move and leave jj's raw refusal to reach the user.
      const isDescendant = yield* driver
        .countRevset(input.cwd, `${localBookmarkRevset(input.name)} & ::(${input.revset})`)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not compare bookmark ancestry."));
      if (isDescendant === 0) {
        return yield* Effect.fail(
          jjFailure(
            input.operation,
            input.cwd,
            `Bookmark ${input.name} points at a change that is not an ancestor of this one. Move it in jj (\`jj bookmark set ${input.name} -r @ --allow-backwards\`) if that is what you want.`,
          ),
        );
      }

      yield* run(
        input.operation,
        input.cwd,
        ["bookmark", "set", bookmarkNameArgument(input.name), "-r", input.revset],
        {
          timeoutMs: 20_000,
        },
      ).pipe(mapJjFailure(input.operation, input.cwd, `Could not move bookmark ${input.name}.`));
      yield* driver.invalidateRepoCaches(input.cwd);
    },
  );

  const pushBookmark: JjRemoteOps["pushBookmark"] = Effect.fn("JjRemotes.pushBookmark")(
    function* (input) {
      const change = yield* driver
        .currentChange(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not read the working-copy change."));
      if (change.conflict) {
        return yield* Effect.fail(
          jjFailure(input.operation, input.cwd, "Resolve conflicts in this change before pushing."),
        );
      }
      const paths = yield* driver
        .ensureUsable(input.operation, input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "This Jujutsu repository cannot be used."));
      const readUpstream = (key: string) =>
        JjProcess.colocatedGitCommand(
          process,
          input.operation,
          { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
          ["config", "--get", `branch.${input.name}.${key}`],
          { allowNonZeroExit: true, timeoutMs: 10_000 },
        ).pipe(
          Effect.map((result) => result.stdout.trim()),
          mapJjFailure(input.operation, input.cwd, "Could not read the bookmark upstream."),
        );
      const configuredMerge = yield* readUpstream("merge");
      // Ordinary git upstreams may name a base branch; only imported PR aliases require protection.
      if (
        configuredMerge.length > 0 &&
        configuredMerge !== `refs/heads/${input.name}` &&
        (yield* readUpstream("t3code-imported-pr-head")) === "true"
      ) {
        const configuredRemote = yield* readUpstream("remote");
        return yield* Effect.fail(
          jjFailure(
            input.operation,
            input.cwd,
            `Bookmark ${input.name} tracks ${configuredRemote}/${configuredMerge.replace(/^refs\/heads\//, "")}. Push this imported pull-request head from its source repository; jj cannot push a differently named bookmark.`,
          ),
        );
      }

      const bookmarks = yield* driver
        .listBookmarks(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not list Jujutsu bookmarks."));
      const existing = bookmarks.find(
        (bookmark) => bookmark.name === input.name && bookmark.remote === null,
      );
      // A bookmarked descendant includes every snapshot of `@` too, not just a bookmark on `@`.
      if (
        existing !== undefined &&
        (yield* driver
          .countRevset(input.cwd, `@ & ::${localBookmarkRevset(input.name)}`)
          .pipe(mapJjFailure(input.operation, input.cwd, "Could not check bookmark ancestry."))) > 0
      ) {
        return yield* Effect.fail(
          jjFailure(
            input.operation,
            input.cwd,
            `Bookmark ${input.name} includes your working copy. Commit this change before pushing it.`,
          ),
        );
      }

      if (change.parentCommitIds.length > 0) {
        yield* bookmarkTo({
          cwd: input.cwd,
          name: input.name,
          revset: "@-",
          operation: input.operation,
          preserveDescendants: true,
        });
      }

      // Compared, not parsed: `--quiet` suppresses jj's own "Nothing changed." line, and the remote
      // row already records what the remote holds.
      const moved = yield* driver
        .listBookmarks(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not list Jujutsu bookmarks."));
      const localTarget = moved.find(
        (bookmark) => bookmark.name === input.name && bookmark.remote === null,
      )?.target;
      const remoteTarget = moved.find(
        (bookmark) => bookmark.name === input.name && bookmark.remote === input.remoteName,
      )?.target;
      if (localTarget !== undefined && localTarget !== null && localTarget === remoteTarget) {
        return { status: "skipped_up_to_date" as const, refName: input.name };
      }

      const gitPaths = { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot };
      const captured = yield* capturePrivateRemoteRefs(
        process,
        gitPaths,
        input.operation,
        input.remoteName,
        input.name,
      );

      const result = yield* run(
        input.operation,
        input.cwd,
        [
          "git",
          "push",
          "--bookmark",
          exactStringPattern(input.name),
          "--remote",
          exactStringPattern(input.remoteName),
        ],
        { allowNonZeroExit: true, timeoutMs: PUSH_TIMEOUT_MS },
      ).pipe(mapJjFailure(input.operation, input.cwd, `Could not push ${input.name}.`));

      if (result.exitCode !== 0) {
        const stderr = boundedStderr(result.stderr);
        // `--allow-empty-description` is never passed on the user's behalf: an undescribed commit
        // reaching a remote is a decision, not a default.
        const detail = stderr.toLowerCase().includes("no description")
          ? "Describe this change before pushing."
          : stderr || `Could not push ${input.name}.`;
        const cause = new GitCommandError({
          operation: input.operation,
          command: "jj",
          cwd: input.cwd,
          detail,
          reason: classifyGitFailure(result.stderr.replace(/^Error:/gm, "error:")) ?? undefined,
        });
        // jj's local validation (description/conflicts/etc.) remains actionable. Only a failure
        // after transport began may be replaced with bounded hosting-specific guidance.
        const transportFailed =
          /Failed to push|remote:|remote rejected|failed to connect|authentication failed|permission denied|could not resolve host/i.test(
            result.stderr,
          );
        return yield* Effect.fail(
          input.pushFailureDetail !== undefined && transportFailed
            ? jjFailure(
                input.operation,
                input.cwd,
                input.pushFailureDetail(cause, input.remoteName),
                cause,
              )
            : cause,
        );
      }

      yield* deleteCapturedPrivateRemoteRefs(process, gitPaths, input.operation, captured);

      return { status: "pushed" as const, refName: input.name };
    },
  );

  const pullCurrentBranch: JjRemoteOps["pullCurrentBranch"] = Effect.fn(
    "JjRemotes.pullCurrentBranch",
  )(function* (cwd) {
    const operation = "JjRemotes.pullCurrentBranch";
    const remoteName = yield* requirePrimaryRemoteName(operation, cwd);

    // Read the bookmark before fetching: jj fast-forwards a tracked bookmark during the fetch
    // itself, and `@` is then no longer a descendant of it.
    const segment = yield* driver
      .currentSegment(cwd)
      .pipe(mapJjFailure(operation, cwd, "Could not read the current bookmark."));
    const refName = yield* resolveWorkspaceRefName(driver, cwd, segment).pipe(
      mapJjFailure(operation, cwd, "Could not resolve the workspace bookmark."),
    );
    if (refName === null) {
      return yield* Effect.fail(
        jjFailure(
          operation,
          cwd,
          "This workspace is not on a bookmark, so there is nothing to pull.",
        ),
      );
    }

    yield* fetchRemote({ cwd, remoteName });

    const upstreamRef = `${remoteName}/${refName}`;
    const upstream = yield* resolveUpstreamContext(driver, cwd, refName);

    const counts = yield* computeAheadBehindCounts(driver, cwd, {
      refName,
      primaryRemote: remoteName,
      defaultBookmark: upstream.defaultBookmark,
      hasUpstream: upstream.hasUpstream,
    });
    if (counts.behindCount === 0) {
      return { status: "skipped_up_to_date" as const, refName, upstreamRef };
    }

    const change = yield* driver
      .currentChange(cwd)
      .pipe(mapJjFailure(operation, cwd, "Could not read the working-copy change."));
    if (counts.aheadCount > 0 || !change.empty) {
      return yield* Effect.fail(
        jjFailure(
          operation,
          cwd,
          `${refName} has local changes. Rebase onto ${upstreamRef} in jj instead of pulling.`,
        ),
      );
    }

    // A true fast-forward: the ancestry check inside `bookmarkTo` is exactly the ff-only test.
    yield* bookmarkTo({
      cwd,
      name: refName,
      revset: remoteBookmarkRevset(remoteName, refName),
      operation,
    });
    yield* run(operation, cwd, ["rebase", "-r", "@", "-d", localBookmarkRevset(refName)], {
      timeoutMs: 60_000,
    }).pipe(mapJjFailure(operation, cwd, `Could not move onto ${refName}.`));

    return { status: "pulled" as const, refName, upstreamRef };
  });

  const publishRepository: JjRemoteOps["publishRepository"] = Effect.fn(
    "JjRemotes.publishRepository",
  )(function* (input) {
    const operation = "JjRemotes.publishRepository";
    const remoteName = yield* ensureJjRemote({ ...input, driver, process, operation });

    const segment = yield* driver
      .currentSegment(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read the current bookmark."));
    const bookmarks = yield* driver
      .listBookmarks(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
    const workspaceRefName = yield* resolveWorkspaceRefName(driver, input.cwd, segment).pipe(
      mapJjFailure(operation, input.cwd, "Could not resolve the workspace bookmark."),
    );
    if (workspaceRefName === null) {
      const paths = yield* driver
        .repoPaths(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not read the workspace path."));
      const workspaces = yield* driver
        .listWorkspaces(input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu workspaces."));
      const workspace = workspaces.find((entry) => entry.root === paths.workspaceRoot);
      if (workspace !== undefined && isT3WorkspaceName(workspace.name)) {
        return yield* Effect.fail(
          jjFailure(
            operation,
            input.cwd,
            "This workspace bookmark is missing. Restore it before publishing this repository.",
          ),
        );
      }
    }
    const refName =
      workspaceRefName ??
      (yield* driver.resolveDefaultBookmark(input.cwd).pipe(Effect.orElseSucceed(() => null))) ??
      resolveAutoFeatureBranchName(
        bookmarks.filter((bookmark) => bookmark.remote === null).map((bookmark) => bookmark.name),
        "main",
      );

    const change = yield* driver
      .currentChange(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read the working-copy change."));
    if (change.parentCommitIds.length === 0) {
      return { refName, remoteName, status: "remote_added" as const };
    }

    yield* bookmarkTo({
      cwd: input.cwd,
      name: refName,
      revset: "@-",
      operation,
      preserveDescendants: true,
    });
    yield* pushBookmark({
      cwd: input.cwd,
      name: refName,
      remoteName,
      operation,
      ...(input.pushFailureDetail === undefined
        ? {}
        : { pushFailureDetail: input.pushFailureDetail }),
    });
    return { refName, remoteName, status: "pushed" as const };
  });

  return {
    fetchRemote,
    remoteExists,
    remoteBranchExists,
    resolveRemoteTrackingCommit,
    resolveWorktreeBaseRemote,
    fetchWorktreeBaseCommit,
    requirePrimaryRemoteName,
    bookmarkTo,
    pushBookmark,
    pullCurrentBranch,
    publishRepository,
  };
};
