import * as Effect from "effect/Effect";

import { GitCommandError, type VcsPullResult } from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";

import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { localBookmarkRevset, remoteBookmarkRevset, splitRemoteRefName } from "../vcs/JjRevset.ts";
import type { JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import {
  computeAheadBehindCounts,
  refNameFromSegment,
  resolveUpstreamContext,
} from "./JjStatus.ts";

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;

/** jj stderr is the only place the real reason lives; bound it the way the git path bounds its own. */
const STDERR_DETAIL_MAX_CHARS = 500;

function boundedStderr(stderr: string): string {
  return stderr.trim().slice(0, STDERR_DETAIL_MAX_CHARS);
}

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
    yield* write(`branch.${input.name}.merge`, `refs/heads/${input.name}`);
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
  // The `<name>@<remote>` argument form is deprecated in 0.42 and prints a warning on every call.
  yield* JjProcess.jjCommand(
    input.process,
    input.operation,
    input.cwd,
    ["bookmark", "track", input.name, `--remote=${input.remoteName}`],
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

export interface JjRemoteOpsDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
}

export interface JjBookmarkMoveInput {
  readonly cwd: string;
  readonly name: string;
  readonly revset: string;
  readonly operation: string;
}

export interface JjPublishResult {
  readonly refName: string;
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
  "fetchRemote" | "remoteExists" | "remoteBranchExists" | "resolveRemoteTrackingCommit"
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
  }) => Effect.Effect<JjPushResult, GitCommandError>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly publishRepository: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly remoteUrl: string;
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
      yield* run(
        "JjRemotes.fetchRemote",
        input.cwd,
        ["git", "fetch", "--remote", input.remoteName],
        { timeoutMs: FETCH_TIMEOUT_MS },
      ).pipe(
        mapJjFailure(
          "JjRemotes.fetchRemote",
          input.cwd,
          `Could not fetch from ${input.remoteName}.`,
        ),
      );
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

    const change = yield* driver.changeAt(input.cwd, remoteBookmarkRevset(remoteName, name)).pipe(
      Effect.orElseSucceed(() => null),
      mapJjFailure(operation, input.cwd, "Could not resolve the remote bookmark."),
    );
    if (change === null) {
      return yield* Effect.fail(
        jjFailure(operation, input.cwd, `${remoteName}/${name} does not exist on the remote.`),
      );
    }
    return { commitSha: change.commitId, remoteRefName: `${remoteName}/${name}` };
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
          ["bookmark", "create", input.name, "-r", input.revset],
          { timeoutMs: 20_000 },
        ).pipe(
          mapJjFailure(input.operation, input.cwd, `Could not create bookmark ${input.name}.`),
        );
        return;
      }

      const target = yield* driver
        .changeAt(input.cwd, input.revset)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not resolve the target revision."));
      if (target !== null && existing.target === target.commitId) {
        return;
      }

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

      yield* run(input.operation, input.cwd, ["bookmark", "set", input.name, "-r", input.revset], {
        timeoutMs: 20_000,
      }).pipe(mapJjFailure(input.operation, input.cwd, `Could not move bookmark ${input.name}.`));
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

      const bookmarks = yield* driver
        .listBookmarks(input.cwd)
        .pipe(mapJjFailure(input.operation, input.cwd, "Could not list Jujutsu bookmarks."));
      const existing = bookmarks.find(
        (bookmark) => bookmark.name === input.name && bookmark.remote === null,
      );
      // A bookmark that sits on `@` follows every snapshot, and jj accepts the push, so a bare Push
      // would publish whatever is in the editor. Moving it for them is worse than refusing.
      if (existing !== undefined && existing.target === change.commitId) {
        return yield* Effect.fail(
          jjFailure(
            input.operation,
            input.cwd,
            `Bookmark ${input.name} points at your working copy. Commit this change before pushing it.`,
          ),
        );
      }

      if (change.parentCommitIds.length > 0) {
        yield* bookmarkTo({
          cwd: input.cwd,
          name: input.name,
          revset: "@-",
          operation: input.operation,
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

      const result = yield* run(
        input.operation,
        input.cwd,
        ["git", "push", "--bookmark", input.name, "--remote", input.remoteName],
        { allowNonZeroExit: true, timeoutMs: PUSH_TIMEOUT_MS },
      ).pipe(mapJjFailure(input.operation, input.cwd, `Could not push ${input.name}.`));

      if (result.exitCode !== 0) {
        const stderr = boundedStderr(result.stderr);
        // `--allow-empty-description` is never passed on the user's behalf: an undescribed commit
        // reaching a remote is a decision, not a default.
        const detail = stderr.toLowerCase().includes("no description")
          ? "Describe this change before pushing."
          : stderr || `Could not push ${input.name}.`;
        return yield* Effect.fail(jjFailure(input.operation, input.cwd, detail));
      }

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
    const refName = refNameFromSegment(segment);
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
    yield* run(operation, cwd, ["new", localBookmarkRevset(refName)], {
      timeoutMs: 60_000,
    }).pipe(mapJjFailure(operation, cwd, `Could not move onto ${refName}.`));

    return { status: "pulled" as const, refName, upstreamRef };
  });

  const publishRepository: JjRemoteOps["publishRepository"] = Effect.fn(
    "JjRemotes.publishRepository",
  )(function* (input) {
    const operation = "JjRemotes.publishRepository";
    const existingRemotes = yield* driver
      .listRemoteNames(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read this repository's remotes."));

    yield* run(
      operation,
      input.cwd,
      existingRemotes.includes(input.remoteName)
        ? ["git", "remote", "set-url", input.remoteName, input.remoteUrl]
        : ["git", "remote", "add", input.remoteName, input.remoteUrl],
      { timeoutMs: 20_000 },
    ).pipe(mapJjFailure(operation, input.cwd, `Could not configure remote ${input.remoteName}.`));
    yield* driver.invalidateRepoCaches(input.cwd);

    const segment = yield* driver
      .currentSegment(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read the current bookmark."));
    const bookmarks = yield* driver
      .listBookmarks(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not list Jujutsu bookmarks."));
    const refName =
      refNameFromSegment(segment) ??
      (yield* driver.resolveDefaultBookmark(input.cwd).pipe(Effect.orElseSucceed(() => null))) ??
      resolveAutoFeatureBranchName(
        bookmarks.filter((bookmark) => bookmark.remote === null).map((bookmark) => bookmark.name),
        "main",
      );

    const change = yield* driver
      .currentChange(input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "Could not read the working-copy change."));
    if (change.parentCommitIds.length === 0) {
      return { refName, status: "remote_added" as const };
    }

    yield* bookmarkTo({ cwd: input.cwd, name: refName, revset: "@-", operation });
    yield* pushBookmark({
      cwd: input.cwd,
      name: refName,
      remoteName: input.remoteName,
      operation,
    });
    return { refName, status: "pushed" as const };
  });

  return {
    fetchRemote,
    remoteExists,
    remoteBranchExists,
    resolveRemoteTrackingCommit,
    requirePrimaryRemoteName,
    bookmarkTo,
    pushBookmark,
    pullCurrentBranch,
    publishRepository,
  };
};
