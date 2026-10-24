import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  GitCommandError,
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
  readonly descendants: Effect.Effect<ReadonlyArray<JjSegmentRow>, VcsError>;
  readonly workspaces: Effect.Effect<ReadonlyArray<JjWorkspace>, VcsError>;
}

const StatusRefreshReads = Context.Reference<
  SynchronizedRef.SynchronizedRef<ReadonlyMap<string, RefreshReads>> | undefined
>("t3/jj/StatusRefreshReads", { defaultValue: () => undefined });

/** A concrete read-only scope; a mutation must start a new scope. Git never reads it. */
export const withStatusRefreshReads = Effect.fn("JjStatus.withStatusRefreshReads")(function* <
  A,
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const reads = yield* SynchronizedRef.make<ReadonlyMap<string, RefreshReads>>(new Map());
  return yield* effect.pipe(Effect.provideService(StatusRefreshReads, reads));
});

const refreshReads = Effect.fn("JjStatus.refreshReads")(function* (
  driver: JjVcsDriverShape,
  cwd: string,
) {
  const scope = yield* StatusRefreshReads;
  const make = Effect.gen(function* () {
    const rows = yield* Effect.cached(driver.currentSegment(cwd, { includeDescendants: true }));
    return {
      segment: rows.pipe(Effect.map((segment) => segment.filter((row) => !row.descendant))),
      descendants: rows.pipe(Effect.map((segment) => segment.filter((row) => row.descendant))),
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

/**
 * The bookmark a workspace is working under: the lexicographically first name on the LAST
 * bookmarked row of `heads(::@ & bookmarks())::@`. Both halves keep the value stable across polls,
 * which is what stops `VcsStatusBroadcaster`'s fingerprint from churning on every tick.
 */
export function refNameFromSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  excludedManagedWorkspaces?: ReadonlySet<string>,
): string | null {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const row = segment[index];
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
  driver: Pick<JjVcsDriverShape, "repoPaths" | "listWorkspaces" | "changeAt">,
  cwd: string,
  segment: ReadonlyArray<JjSegmentRow>,
  knownWorkspaces?: ReadonlyArray<JjWorkspace>,
  knownDescendants?: ReadonlyArray<JjSegmentRow>,
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
  const currentRef = refNameFromSegment(segment.slice(0, 1), otherManagedWorkspaces);
  if (currentRef !== null) return currentRef;
  // Editing an ancestor keeps the descendant bookmark as the branch being reviewed.
  // Prefer the nearest bookmarked descendants before falling back to an ancestor.
  const descendants =
    knownDescendants ??
    (yield* driver
      .changeAt(cwd, "roots((@:: & bookmarks()) ~ @)")
      .pipe(Effect.map((descendant) => (descendant === null ? [] : [descendant]))));
  if (descendants.length > 0) {
    const descendantRef = refNameFromSegment(descendants.slice(0, 1), otherManagedWorkspaces);
    if (descendantRef !== null) return descendantRef;
  }
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

// jj's tracking counts are remote-relative and fail inline for untracked bookmarks.
export const computeAheadBehindCounts = Effect.fn("JjStatus.computeAheadBehindCounts")(function* (
  driver: JjVcsDriverShape,
  cwd: string,
  input: {
    readonly refName: string;
    readonly localRefName?: string;
    readonly primaryRemote: string | null;
    readonly defaultBookmark: string | null;
    readonly hasUpstream: boolean;
  },
): Effect.fn.Return<JjAheadBehindCounts, GitCommandError> {
  const remoteRevset =
    input.primaryRemote === null ? null : remoteBookmarkRevset(input.primaryRemote, input.refName);
  const localRevset = localBookmarkRevset(input.localRefName ?? input.refName);
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
          : driver.countRevset(cwd, `${localRevset}..${remoteRevset}`),
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
): Effect.fn.Return<number, GitCommandError> {
  const read = JjProcess.colocatedGitCommand(
    process,
    "JjStatus.countGitChanges",
    { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
    ["log", "--format=format:t3-commit", "--max-count=1000", range],
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
  const commits = result.value.stdout
    .split("\n")
    .filter((line) => line.trim() === "t3-commit").length;
  return commits >= 1000 ? Math.max(1000, yield* fallback) : commits;
});

const countAheadChanges = Effect.fn("JjStatus.countAheadChanges")(function* (
  driver: JjVcsDriverShape,
  process: VcsProcess.VcsProcess["Service"],
  paths: { readonly gitDir: string; readonly mainWorkspaceRoot: string },
  cwd: string,
  remoteCommit: string,
) {
  const change = yield* driver
    .changeAt(cwd, "@")
    .pipe(
      mapJjFailure("JjStatus.countAheadChanges", cwd, "Could not read the working-copy change."),
    );
  if (change === null) {
    return yield* new GitCommandError({
      operation: "JjStatus.countAheadChanges",
      command: "jj",
      cwd,
      detail: "Could not read the working-copy change.",
    });
  }
  const localCommit = change.commitId;
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
  // Merge bases are already known to jj even if the refreshed remote tip is not.
  // Let jj decide emptiness against its own merged-parent tree.
  const mergeBases = bases.stdout.trim();
  const revset =
    bases.exitCode === 1
      ? `::${localCommit} ~ empty()`
      : `(${mergeBases.split("\n").join("|")})..${localCommit} ~ empty()`;
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

export const makeJjStatus = Effect.fn("JjStatus.makeJjStatus")(function* (
  deps: JjStatusDeps,
): Effect.fn.Return<JjStatusOps> {
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
                  "--",
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
      Effect.catchTags({
        VcsUnsupportedOperationError: (error) => Effect.succeed(error.detail),
      }),
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
      mapJjFailure("JjStatus.localStatus", input.cwd, "Could not read the working-copy snapshot."),
    );

    const refName = yield* Effect.all([reads.workspaces, reads.descendants]).pipe(
      Effect.flatMap(([workspaces, descendants]) =>
        resolveWorkspaceRefName(driver, input.cwd, readings.segment, workspaces, descendants),
      ),
      mapJjFailure("JjStatus.localStatus", input.cwd, "Could not resolve the workspace bookmark."),
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
      Effect.catchTags({
        VcsUnsupportedOperationError: () => Effect.succeed(null),
      }),
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
        : yield* Effect.all([reads.workspaces, reads.descendants]).pipe(
            Effect.flatMap(([workspaces, descendants]) =>
              resolveWorkspaceRefName(driver, input.cwd, segment, workspaces, descendants),
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
          mapJjFailure("JjStatus.remoteStatus", input.cwd, "Could not resolve the primary remote."),
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
            mapJjFailure("JjStatus.readBackgroundRemote", input.cwd, "Could not read remote ref."),
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
    const localCommit = upstream.bookmarks.find(
      (bookmark) => bookmark.name === refName && bookmark.remote === null,
    )?.target;
    const counts =
      usePrivateCounts && refreshed !== null && hasUpstream && localCommit != null
        ? {
            ...(yield* computeAheadBehindCounts(driver, input.cwd, {
              refName: upstreamRefName,
              localRefName: refName,
              primaryRemote: null,
              defaultBookmark: upstream.defaultBookmark,
              hasUpstream,
            })),
            ...(yield* Effect.all({
              aheadCount: countAheadChanges(driver, process, paths, input.cwd, refreshed),
              behindCount: countGitChanges(
                process,
                paths,
                `${localCommit}..${refreshed}`,
                computeAheadBehindCounts(driver, input.cwd, {
                  refName: upstreamRefName,
                  localRefName: refName,
                  primaryRemote,
                  defaultBookmark: upstream.defaultBookmark,
                  hasUpstream,
                }).pipe(Effect.map((value) => value.behindCount)),
              ),
            })),
          }
        : yield* computeAheadBehindCounts(driver, input.cwd, {
            refName: upstreamRefName,
            localRefName: refName,
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
              ...(pullRequest.updatedAt !== undefined ? { updatedAt: pullRequest.updatedAt } : {}),
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
