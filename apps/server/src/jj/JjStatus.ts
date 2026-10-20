import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  GitCommandError,
  VcsUnsupportedOperationError,
  type VcsStatusInput,
  type VcsError,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import type * as GitManager from "../git/GitManager.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { localBookmarkRevset, remoteBookmarkRevset } from "../vcs/JjRevset.ts";
import type {
  JjBookmark,
  JjSegmentRow,
  JjVcsDriverShape,
  JjWorkspace,
} from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { mapJjFailure } from "./JjFailure.ts";
import { isT3WorkspaceName, workspaceNameForRef } from "./JjWorkspaces.ts";

interface RefreshReads {
  readonly segment: Effect.Effect<ReadonlyArray<JjSegmentRow>, VcsError>;
  readonly workspaces: Effect.Effect<ReadonlyArray<JjWorkspace>, VcsError>;
}

const StatusRefreshReads = Context.Reference<
  SynchronizedRef.SynchronizedRef<ReadonlyMap<string, RefreshReads>> | undefined
>("t3/jj/StatusRefreshReads", { defaultValue: () => undefined });

/** A concrete read-only scope; a mutation must start a new scope. Git never reads it. */
export const withStatusRefreshReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reads = yield* SynchronizedRef.make<ReadonlyMap<string, RefreshReads>>(new Map());
    return yield* effect.pipe(Effect.provideService(StatusRefreshReads, reads));
  });

const refreshReads = (driver: JjVcsDriverShape, cwd: string) =>
  Effect.gen(function* () {
    const scope = yield* StatusRefreshReads;
    const make = Effect.gen(function* () {
      return {
        segment: yield* Effect.cached(driver.currentSegment(cwd)),
        workspaces: yield* Effect.cached(driver.listWorkspaces(cwd)),
      };
    });
    if (scope === undefined) return yield* make;
    return yield* SynchronizedRef.modifyEffect(scope, (entries) =>
      Effect.gen(function* () {
        const existing = entries.get(cwd);
        if (existing !== undefined) return [existing, entries] as const;
        const reads = yield* make;
        return [reads, new Map(entries).set(cwd, reads)] as const;
      }),
    );
  });

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

function upstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

const EMPTY_LOCAL_STATUS = {
  refName: null,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
} as const;

/** Newest-first segment order makes the first eligible bookmarked row the nearest ancestor. */
export function refNameFromSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  excludedManagedWorkspaces?: ReadonlySet<string>,
): string | null {
  for (const row of segment) {
    if (row !== undefined && row.localBookmarks.length > 0) {
      let selected: string | null = null;
      for (const bookmark of row.localBookmarks) {
        if (excludedManagedWorkspaces?.has(workspaceNameForRef(bookmark))) continue;
        if (selected === null || bookmark < selected) selected = bookmark;
      }
      if (selected !== null) return selected;
    }
  }
  return null;
}

export function refNameFromWorkspaceSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  workspaceName: string,
): string | null {
  if (!isT3WorkspaceName(workspaceName)) {
    return refNameFromSegment(segment);
  }
  // A deleted thread bookmark must not redirect writes onto another bookmark such as main.
  for (const row of segment) {
    const bookmark = row.localBookmarks.find((name) => workspaceNameForRef(name) === workspaceName);
    if (bookmark !== undefined) return bookmark;
  }
  return null;
}

export const resolveWorkspaceRefName = Effect.fn("JjStatus.resolveWorkspaceRefName")(function* (
  driver: Pick<
    JjVcsDriverShape,
    "repoPaths" | "listWorkspaces" | "changeAt" | "listBookmarks" | "countRevset"
  >,
  cwd: string,
  segment: ReadonlyArray<JjSegmentRow>,
  knownWorkspaces?: ReadonlyArray<JjWorkspace>,
) {
  const paths = yield* driver.repoPaths(cwd);
  const workspaces = knownWorkspaces ?? (yield* driver.listWorkspaces(cwd));
  const workspace = workspaces.find((entry) => entry.root === paths.workspaceRoot);
  if (workspace === undefined) return null;
  if (isT3WorkspaceName(workspace.name)) {
    return refNameFromWorkspaceSegment(segment, workspace.name);
  }
  // Child bookmarks can share the parent's revision without becoming the parent's current ref.
  const otherManagedWorkspaces = new Set<string>();
  for (const entry of workspaces) {
    if (entry.name !== workspace.name && isT3WorkspaceName(entry.name)) {
      otherManagedWorkspaces.add(entry.name);
    }
  }
  // Select only eligible local names before finding roots; managed workspaces cannot hide a
  // farther eligible descendant. Multiple roots or names are ambiguous, never a trunk fallback.
  let eligibleRevset = "bookmarks()";
  if (otherManagedWorkspaces.size > 0) {
    const eligible = (yield* driver.listBookmarks(cwd)).filter(
      (bookmark) =>
        bookmark.remote === null && !otherManagedWorkspaces.has(workspaceNameForRef(bookmark.name)),
    );
    if (eligible.length === 0) return refNameFromSegment(segment, otherManagedWorkspaces);
    eligibleRevset = eligible.map((bookmark) => localBookmarkRevset(bookmark.name)).join(" | ");
  }
  const revset = `roots(@:: & (${eligibleRevset}))`;
  const count = yield* driver.countRevset(cwd, revset);
  const descendant = count === 1 ? yield* driver.changeAt(cwd, revset) : null;
  const names =
    descendant?.localBookmarks.filter(
      (name) => !otherManagedWorkspaces.has(workspaceNameForRef(name)),
    ) ?? [];
  if (count > 1 || names.length > 1) {
    return yield* Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "JjStatus.resolveWorkspaceRefName",
        kind: "jj",
        detail:
          "Ambiguous descendant bookmarks. Switch to the intended bookmark before continuing.",
      }),
    );
  }
  if (names.length === 1) return names[0]!;
  return refNameFromSegment(segment, otherManagedWorkspaces);
});

/**
 * Work the agent committed but never bookmarked: every row of the segment below `@`. `jj new`
 * would hide it from `listRefs` and from the segment query alike, so switching away and removing
 * a workspace both have to refuse over it.
 */
export function strandedSegmentRows(
  segment: ReadonlyArray<JjSegmentRow>,
): ReadonlyArray<JjSegmentRow> {
  return segment.slice(0, -1).filter((row) => !row.empty && row.localBookmarks.length === 0);
}

export const readImportedUpstream = Effect.fn("JjStatus.readImportedUpstream")(function* (
  process: VcsProcess.VcsProcess["Service"],
  paths: { readonly gitDir: string; readonly mainWorkspaceRoot: string },
  refName: string,
) {
  const read = (key: string) =>
    JjProcess.colocatedGitCommand(
      process,
      "JjStatus.readImportedUpstream",
      { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
      ["config", "--get", `branch.${refName}.${key}`],
    ).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
  if ((yield* read("t3code-imported-pr-head")) !== "true") return null;
  const [remoteName, merge] = yield* Effect.all([read("remote"), read("merge")]);
  if (remoteName.length === 0 || !merge.startsWith("refs/heads/")) return null;
  const branch = merge.slice("refs/heads/".length);
  return branch.length === 0 ? null : { remoteName, branch };
});

/**
 * The primary remote, whether `refName` tracks a bookmark on it, and the repository's default
 * bookmark: the three readings every ahead/behind and push decision starts from.
 */
export const resolveUpstreamContext = Effect.fn("JjStatus.resolveUpstreamContext")(function* (
  driver: JjVcsDriverShape,
  cwd: string,
  refName: string,
): Effect.fn.Return<
  {
    readonly primaryRemote: string | null;
    readonly hasUpstream: boolean;
    readonly defaultBookmark: string | null;
    readonly bookmarks: ReadonlyArray<JjBookmark>;
  },
  GitCommandError
> {
  const [primaryRemote, bookmarks, defaultBookmark] = yield* Effect.all([
    driver
      .resolvePrimaryRemoteName(cwd)
      .pipe(
        mapJjFailure(
          "JjStatus.resolveUpstreamContext",
          cwd,
          "Could not resolve the primary remote.",
        ),
      ),
    driver
      .listBookmarks(cwd)
      .pipe(
        mapJjFailure("JjStatus.resolveUpstreamContext", cwd, "Could not read remote bookmarks."),
      ),
    driver
      .resolveDefaultBookmark(cwd)
      .pipe(
        mapJjFailure(
          "JjStatus.resolveUpstreamContext",
          cwd,
          "Could not resolve the default bookmark.",
        ),
      ),
  ]);
  const hasUpstream = bookmarks.some(
    (bookmark) =>
      bookmark.name === refName && bookmark.remote === primaryRemote && bookmark.tracked,
  );
  return { primaryRemote, hasUpstream, defaultBookmark, bookmarks };
});

export interface JjAheadBehindCounts {
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly aheadOfDefaultCount: number;
}

/**
 * Ahead/behind from revsets rather than from jj's `tracking_*_count` template keywords: those are
 * measured from the remote ref's point of view (the inverse of git's) and render an inline error
 * into stdout for an untracked bookmark. `~ empty()` drops the empty working-copy commit so "2
 * ahead" means two real changes. Measured to `@`, so an agent's own `jj commit`s count as ahead.
 */
export const computeAheadBehindCounts = Effect.fn("JjStatus.computeAheadBehindCounts")(function* (
  driver: JjVcsDriverShape,
  cwd: string,
  input: {
    readonly refName: string;
    readonly primaryRemote: string | null;
    readonly defaultBookmark: string | null;
    readonly hasUpstream: boolean;
  },
): Effect.fn.Return<JjAheadBehindCounts, GitCommandError> {
  const remoteRevset =
    input.primaryRemote === null ? null : remoteBookmarkRevset(input.primaryRemote, input.refName);
  const defaultRevset =
    input.defaultBookmark === null ? null : localBookmarkRevset(input.defaultBookmark);

  const counts = yield* Effect.all(
    {
      aheadCount:
        remoteRevset === null
          ? Effect.succeed(0)
          : driver.countRevset(cwd, `(${remoteRevset}..@) ~ empty()`),
      behindCount:
        remoteRevset === null
          ? Effect.succeed(0)
          : driver.countRevset(cwd, `(@..${remoteRevset}) ~ empty()`),
      aheadOfDefaultCount:
        defaultRevset === null
          ? Effect.succeed(0)
          : driver.countRevset(cwd, `(${defaultRevset}..@) ~ empty()`),
    },
    { concurrency: 3 },
  ).pipe(
    mapJjFailure(
      "JjStatus.computeAheadBehindCounts",
      cwd,
      "Could not count changes against the remote bookmark.",
    ),
  );

  // A never-pushed bookmark still reports what the agent committed, the way git falls back to
  // counting against the base branch. Zeroing both would disable Push for every new jj thread.
  return input.hasUpstream
    ? counts
    : {
        aheadCount: counts.aheadOfDefaultCount,
        behindCount: 0,
        aheadOfDefaultCount: counts.aheadOfDefaultCount,
      };
});

const countGitChanges = Effect.fn("JjStatus.countGitChanges")(function* (
  process: VcsProcess.VcsProcess["Service"],
  paths: { readonly gitDir: string; readonly mainWorkspaceRoot: string },
  range: string,
  fallback: Effect.Effect<number, GitCommandError>,
) {
  const read = JjProcess.colocatedGitCommand(
    process,
    "JjStatus.countGitChanges",
    { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
    [
      "log",
      "--format=format:t3-commit",
      "--shortstat",
      "--no-renames",
      "--max-count=1000",
      "--root",
      "--diff-merges=remerge",
      range,
    ],
    {
      env: { LC_ALL: "C" },
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
      outputMode: "error",
    },
  );
  const result = yield* read.pipe(
    Effect.map((value) => ({ value })),
    Effect.catchTags({
      VcsProcessTimeoutError: () => Effect.succeed(null),
      VcsProcessOutputLimitError: () => Effect.succeed(null),
    }),
    mapJjFailure(
      "JjStatus.countGitChanges",
      paths.mainWorkspaceRoot,
      "Could not count remote changes.",
    ),
  );
  if (result === null) return yield* fallback;
  // Shortstat bounds output by commits rather than changed paths. Remerge omits clean
  // two-parent merges, but Git's rename handling can differ from jj's merged-parent tree.
  // Git also skips octopus remerge diffs, including octopus merges with their own edits.
  let changes = 0;
  let commits = 0;
  let inCommit = false;
  for (const line of result.value.stdout.split("\n")) {
    const value = line.trim();
    if (value === "t3-commit") {
      commits++;
      inCommit = true;
    } else if (inCommit && /^\d+ files? changed(?:,|$)/.test(value)) {
      changes++;
      inCommit = false;
    }
  }
  return commits >= 1000 ? Math.max(1000, yield* fallback) : changes;
});

const countAheadChanges = Effect.fn("JjStatus.countAheadChanges")(function* (
  driver: JjVcsDriverShape,
  process: VcsProcess.VcsProcess["Service"],
  paths: { readonly gitDir: string; readonly mainWorkspaceRoot: string },
  cwd: string,
  remoteCommit: string,
  localCommit: string,
) {
  const bases = yield* JjProcess.colocatedGitCommand(
    process,
    "JjStatus.countAheadChanges",
    { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
    ["merge-base", "--all", remoteCommit, localCommit],
    {
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
      outputMode: "error",
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0 || result.exitCode === 1
        ? Effect.succeed(result)
        : Effect.fail(
            new GitCommandError({
              operation: "JjStatus.countAheadChanges",
              command: "git",
              cwd,
              detail: result.stderr,
            }),
          ),
    ),
    mapJjFailure("JjStatus.countAheadChanges", cwd, "Could not resolve remote ancestry."),
  );
  // Merge bases are ancestors of @ and already known to jj, even if the refreshed
  // remote tip is not. Let jj decide emptiness against its own merged-parent tree.
  const mergeBases = bases.stdout.trim();
  const revset =
    bases.exitCode === 1 ? "::@ ~ empty()" : `(${mergeBases.split("\n").join("|")})..@ ~ empty()`;
  return yield* driver
    .countRevset(cwd, revset)
    .pipe(mapJjFailure("JjStatus.countAheadChanges", cwd, "Could not count local changes."));
});

export interface JjStatusDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly gitManager: GitManager.GitManager["Service"];
  readonly sourceControlProviders: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
}

export interface JjStatusOps {
  readonly localStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusLocalResult, GitCommandError>;
  readonly remoteStatus: (
    input: VcsStatusInput,
    options?: { readonly refreshUpstream?: boolean; readonly refreshMissingPullRequest?: boolean },
  ) => Effect.Effect<VcsStatusRemoteResult | null, GitCommandError>;
  readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
}

export const makeJjStatus = (deps: JjStatusDeps): Effect.Effect<JjStatusOps> =>
  Effect.gen(function* () {
    const { driver, gitManager, process, sourceControlProviders } = deps;

    const upstreamRefreshFailureCounts = new Map<string, number>();
    const recordUpstreamRefreshFailure = (key: string) => {
      const nextCount = (upstreamRefreshFailureCounts.get(key) ?? 0) + 1;
      upstreamRefreshFailureCounts.delete(key);
      upstreamRefreshFailureCounts.set(key, nextCount);
      if (upstreamRefreshFailureCounts.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
        const oldestKey = upstreamRefreshFailureCounts.keys().next().value;
        if (oldestKey !== undefined) {
          upstreamRefreshFailureCounts.delete(oldestKey);
        }
      }
    };

    const upstreamRefreshCache = yield* Cache.makeWith<string, true, GitCommandError>(
      (key) => {
        const [cwd = "", remoteName = ""] = key.split("\0");
        return driver
          .repoPaths(cwd)
          .pipe(
            Effect.flatMap((paths) =>
              Effect.gen(function* () {
                if (paths.gitDir === null)
                  return yield* new GitCommandError({
                    operation: "JjStatus.refreshUpstream",
                    command: "git",
                    cwd,
                    detail: "The Jujutsu repository has no colocated Git repository.",
                  });
                return yield* JjProcess.colocatedGitCommand(
                  process,
                  "JjStatus.refreshUpstream",
                  { gitDir: paths.gitDir, cwd },
                  [
                    // Disable configured opportunistic remote-tracking updates as well.
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--prune",
                    "--refmap=",
                    remoteName,
                    `+refs/heads/*:refs/t3/remotes/${encodeURIComponent(remoteName)}/*`,
                  ],
                  {
                    env: STATUS_UPSTREAM_REFRESH_ENV,
                    timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
                  },
                );
              }),
            ),
          )
          .pipe(
            Effect.as(true as const),
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation: "JjStatus.refreshUpstream",
                  command: "git",
                  cwd,
                  detail: "Background Jujutsu remote refresh failed.",
                  cause,
                }),
            ),
            Effect.tap(() => Effect.sync(() => upstreamRefreshFailureCounts.delete(key))),
            Effect.tapError(() => Effect.sync(() => recordUpstreamRefreshFailure(key))),
          );
      },
      {
        capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
        timeToLive: (exit, key) =>
          Exit.isSuccess(exit)
            ? STATUS_UPSTREAM_REFRESH_INTERVAL
            : upstreamRefreshFailureCooldown(upstreamRefreshFailureCounts.get(key) ?? 1),
      },
    );

    const detectProvider = (cwd: string) =>
      sourceControlProviders.resolveHandle({ cwd }).pipe(
        Effect.map((handle) => handle.context?.provider ?? null),
        Effect.orElseSucceed(() => null),
      );

    const localStatus = Effect.fn("JjStatus.localStatus")(function* (
      input: Parameters<JjStatusOps["localStatus"]>[0],
      knownReads?: RefreshReads,
    ): Effect.fn.Return<VcsStatusLocalResult, GitCommandError> {
      // `ensureUsable` already composes the version probe with the colocation test, so the
      // "detected but unusable" reason the client renders comes from exactly one place.
      const reason = yield* driver.ensureUsable("JjStatus.localStatus", input.cwd).pipe(
        Effect.as(null),
        Effect.catchTag("VcsUnsupportedOperationError", (error) => Effect.succeed(error.detail)),
        mapJjFailure("JjStatus.localStatus", input.cwd, "This Jujutsu repository cannot be read."),
      );
      if (reason !== null) {
        return {
          isRepo: true,
          vcs: { kind: "jj" as const, unsupportedReason: reason },
          ...EMPTY_LOCAL_STATUS,
        };
      }
      const reads = knownReads ?? (yield* refreshReads(driver, input.cwd));

      const readings = yield* Effect.all(
        {
          change: driver.currentChange(input.cwd),
          segment: reads.segment,
        },
        { concurrency: 2 },
      ).pipe(
        mapJjFailure(
          "JjStatus.localStatus",
          input.cwd,
          "Could not read the working-copy snapshot.",
        ),
      );

      const refName = yield* reads.workspaces.pipe(
        Effect.flatMap((workspaces) =>
          resolveWorkspaceRefName(driver, input.cwd, readings.segment, workspaces),
        ),
        mapJjFailure(
          "JjStatus.localStatus",
          input.cwd,
          "Could not resolve the workspace bookmark.",
        ),
      );
      const files = readings.change.fileStats
        .map((file) => ({
          path: file.path,
          insertions: file.linesAdded,
          deletions: file.linesRemoved,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));

      const [provider, remoteNames, defaultBookmark] = yield* Effect.all([
        detectProvider(input.cwd),
        driver
          .listRemoteNames(input.cwd)
          .pipe(mapJjFailure("JjStatus.localStatus", input.cwd, "Could not list remotes.")),
        driver
          .resolveDefaultBookmark(input.cwd)
          .pipe(
            mapJjFailure(
              "JjStatus.localStatus",
              input.cwd,
              "Could not resolve the default bookmark.",
            ),
          ),
      ]);

      const workingTree = {
        files,
        insertions: files.reduce((total, file) => total + file.insertions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      };
      const branchChanges = yield* driver
        .readBranchChangeTotals({
          cwd: input.cwd,
          change: readings.change,
          refName,
        })
        .pipe(
          mapJjFailure("JjStatus.localStatus", input.cwd, "Could not read branch change totals."),
        );

      return {
        isRepo: true,
        vcs: { kind: "jj" as const },
        ...(provider ? { sourceControlProvider: provider } : {}),
        hasPrimaryRemote: remoteNames.length > 0,
        isDefaultRef: refName !== null && refName === defaultBookmark,
        refName,
        hasWorkingTreeChanges: files.length > 0,
        workingTree,
        ...(branchChanges === undefined ? {} : { branchChanges }),
      };
    });

    const remoteStatus = Effect.fn("JjStatus.remoteStatus")(function* (
      input: Parameters<JjStatusOps["remoteStatus"]>[0],
      options?: Parameters<JjStatusOps["remoteStatus"]>[1],
      knownRefName?: string | null,
      knownReads?: RefreshReads,
    ): Effect.fn.Return<VcsStatusRemoteResult | null, GitCommandError> {
      const usable = yield* driver.ensureUsable("JjStatus.remoteStatus", input.cwd).pipe(
        Effect.catchTag("VcsUnsupportedOperationError", () => Effect.succeed(null)),
        mapJjFailure("JjStatus.remoteStatus", input.cwd, "This Jujutsu repository cannot be read."),
      );
      if (usable === null || usable.gitDir === null) return null;
      const paths = { ...usable, gitDir: usable.gitDir };

      const reads = knownReads ?? (yield* refreshReads(driver, input.cwd));
      const segment = yield* reads.segment.pipe(
        mapJjFailure("JjStatus.remoteStatus", input.cwd, "Could not read the workspace segment."),
      );
      const refName =
        knownRefName !== undefined
          ? knownRefName
          : yield* reads.workspaces.pipe(
              Effect.flatMap((workspaces) =>
                resolveWorkspaceRefName(driver, input.cwd, segment, workspaces),
              ),
              mapJjFailure(
                "JjStatus.remoteStatus",
                input.cwd,
                "Could not resolve the workspace bookmark.",
              ),
            );
      if (refName === null) {
        return {
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        };
      }

      const importedUpstream = yield* readImportedUpstream(process, paths, refName);
      const upstreamRefName = importedUpstream?.branch ?? refName;
      const primaryRemote =
        importedUpstream?.remoteName ??
        (yield* driver
          .resolvePrimaryRemoteName(input.cwd)
          .pipe(
            mapJjFailure(
              "JjStatus.remoteStatus",
              input.cwd,
              "Could not resolve the primary remote.",
            ),
          ));

      if (options?.refreshUpstream === true && primaryRemote !== null) {
        yield* Cache.get(upstreamRefreshCache, `${paths.mainWorkspaceRoot}\0${primaryRemote}`).pipe(
          Effect.ignore,
        );
      }

      const upstream = yield* resolveUpstreamContext(driver, input.cwd, refName);
      const remoteRef =
        primaryRemote === null
          ? null
          : `refs/t3/remotes/${encodeURIComponent(primaryRemote)}/${upstreamRefName}`;
      let refreshed =
        remoteRef === null
          ? null
          : yield* JjProcess.colocatedGitCommand(
              process,
              "JjStatus.readBackgroundRemote",
              { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
              ["rev-parse", "--verify", "--quiet", remoteRef],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0
                  ? Effect.succeed(result.stdout.trim())
                  : result.exitCode === 1
                    ? Effect.succeed(null)
                    : Effect.fail(
                        new GitCommandError({
                          operation: "JjStatus.readBackgroundRemote",
                          command: "git",
                          cwd: input.cwd,
                          detail: result.stderr,
                        }),
                      ),
              ),
              mapJjFailure(
                "JjStatus.readBackgroundRemote",
                input.cwd,
                "Could not read remote ref.",
              ),
            );
      const remoteBookmark = upstream.bookmarks.find(
        (bookmark) => bookmark.name === upstreamRefName && bookmark.remote === primaryRemote,
      );
      if (
        refreshed !== null &&
        remoteBookmark?.target &&
        refreshed !== remoteBookmark.target &&
        !remoteBookmark.conflict
      ) {
        const newer = yield* JjProcess.colocatedGitCommand(
          process,
          "JjStatus.readBackgroundRemote",
          { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
          ["merge-base", "--is-ancestor", refreshed, remoteBookmark.target],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 || result.exitCode === 1
              ? Effect.succeed(result.exitCode === 0)
              : Effect.fail(
                  new GitCommandError({
                    operation: "JjStatus.readBackgroundRemote",
                    command: "git",
                    cwd: input.cwd,
                    detail: result.stderr,
                  }),
                ),
          ),
          mapJjFailure(
            "JjStatus.readBackgroundRemote",
            input.cwd,
            "Could not compare remote ancestry.",
          ),
        );
        if (newer) refreshed = remoteBookmark.target;
      }
      const hasUpstream = importedUpstream
        ? refreshed !== null || remoteBookmark !== undefined
        : upstream.hasUpstream;
      const usePrivateCounts =
        refreshed !== null &&
        (remoteBookmark?.conflict === true || refreshed !== remoteBookmark?.target);
      const counts =
        usePrivateCounts && refreshed !== null && hasUpstream && segment.length > 0
          ? {
              ...(yield* computeAheadBehindCounts(driver, input.cwd, {
                refName: upstreamRefName,
                primaryRemote: null,
                defaultBookmark: upstream.defaultBookmark,
                hasUpstream,
              })),
              ...(yield* Effect.all({
                aheadCount: countAheadChanges(
                  driver,
                  process,
                  paths,
                  input.cwd,
                  refreshed,
                  segment[0]!.commitId,
                ),
                behindCount: countGitChanges(
                  process,
                  paths,
                  `${segment[0]!.commitId}..${refreshed}`,
                  computeAheadBehindCounts(driver, input.cwd, {
                    refName: upstreamRefName,
                    primaryRemote,
                    defaultBookmark: upstream.defaultBookmark,
                    hasUpstream,
                  }).pipe(Effect.map((value) => value.behindCount)),
                ),
              })),
            }
          : yield* computeAheadBehindCounts(driver, input.cwd, {
              refName: upstreamRefName,
              primaryRemote,
              defaultBookmark: upstream.defaultBookmark,
              hasUpstream,
            });

      // The PR half of the product runs against the colocated git store: every local bookmark is
      // `refs/heads/<name>` there, so the existing lookup, its cache and its backoff all apply.
      const pullRequest = yield* gitManager
        .branchPullRequest(
          { cwd: paths.mainWorkspaceRoot, branch: refName },
          options?.refreshMissingPullRequest === true ? { refresh: true } : undefined,
        )
        .pipe(Effect.orElseSucceed(() => null));

      return {
        ...counts,
        hasUpstream,
        pr:
          pullRequest === null
            ? null
            : {
                number: pullRequest.number,
                title: pullRequest.title,
                url: pullRequest.url,
                baseRef: pullRequest.baseRef,
                headRef: pullRequest.headRef,
                state: pullRequest.state,
                ...(pullRequest.isDraft !== undefined ? { isDraft: pullRequest.isDraft } : {}),
                ...(pullRequest.updatedAt !== undefined
                  ? { updatedAt: pullRequest.updatedAt }
                  : {}),
              },
      };
    });

    const status: JjStatusOps["status"] = Effect.fn("JjStatus.status")(function* (input) {
      const reads = yield* refreshReads(driver, input.cwd);
      const local = yield* localStatus(input, reads);
      const remote = yield* remoteStatus(input, undefined, local.refName, reads);
      return {
        ...local,
        ...(remote ?? {
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        }),
      };
    });

    return { localStatus, remoteStatus, status };
  });
