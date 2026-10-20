import * as Effect from "effect/Effect";

import { GitCommandError } from "@t3tools/contracts";

import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
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

const FETCH_TIMEOUT_MS = 60_000;
const boundedStderr = (stderr: string) => stderr.trim().slice(-2_000);

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

export type JjRemoteOps = Pick<
  VcsWorkflowOps,
  | "fetchRemote"
  | "remoteExists"
  | "remoteBranchExists"
  | "resolveRemoteTrackingCommit"
  | "resolveWorktreeBaseRemote"
  | "fetchWorktreeBaseCommit"
> & {
  /** Forward-only. `jj bookmark set` refuses a backwards or sideways move, so the guard runs first. */
  readonly bookmarkTo: (input: JjBookmarkMoveInput) => Effect.Effect<void, GitCommandError>;
};

export const makeJjRemotes = (deps: JjRemoteOpsDeps): JjRemoteOps => {
  const { driver, process } = deps;

  const run = JjProcess.jjRunner(process);

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
      yield* deleteCapturedPrivateRemoteRefs(
        process,
        gitPaths,
        "JjRemotes.fetchRemote",
        captured,
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

  return {
    fetchRemote,
    remoteExists,
    remoteBranchExists,
    resolveRemoteTrackingCommit,
    resolveWorktreeBaseRemote,
    fetchWorktreeBaseCommit,
    bookmarkTo,
  };
};
