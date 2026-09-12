import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  GitCommandError,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import type * as GitManager from "../git/GitManager.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { localBookmarkRevset, remoteBookmarkRevset } from "../vcs/JjRevset.ts";
import type { JjSegmentRow, JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { mapJjFailure } from "./JjFailure.ts";

/**
 * Copied by value from `GitVcsDriverCore.ts`: the background refresh under jj has to behave like
 * the one under git, but importing git internals here would tie the two lanes together.
 */
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

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
export function refNameFromSegment(segment: ReadonlyArray<JjSegmentRow>): string | null {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const row = segment[index];
    if (row !== undefined && row.localBookmarks.length > 0) {
      return [...row.localBookmarks].sort()[0] ?? null;
    }
  }
  return null;
}

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
  },
  never
> {
  const [primaryRemote, bookmarks, defaultBookmark] = yield* Effect.all([
    driver.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null)),
    driver.listBookmarks(cwd).pipe(Effect.orElseSucceed(() => [])),
    driver.resolveDefaultBookmark(cwd).pipe(Effect.orElseSucceed(() => null)),
  ]);
  const hasUpstream = bookmarks.some(
    (bookmark) =>
      bookmark.name === refName && bookmark.remote === primaryRemote && bookmark.tracked,
  );
  return { primaryRemote, hasUpstream, defaultBookmark };
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

export interface JjStatusDeps {
  readonly driver: JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly gitManager: GitManager.GitManager["Service"];
  readonly sourceControlProviders: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
}

export interface JjStatusOps {
  readonly localStatus: (input: VcsStatusInput) => Effect.Effect<VcsStatusLocalResult, never>;
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
        const separatorIndex = key.indexOf("\0");
        const cwd = key.slice(0, separatorIndex);
        const remoteName = key.slice(separatorIndex + 1);
        return JjProcess.jjCommand(
          process,
          "JjStatus.refreshUpstream",
          cwd,
          ["git", "fetch", "--remote", remoteName],
          {
            env: STATUS_UPSTREAM_REFRESH_ENV,
            timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
          },
        ).pipe(
          Effect.as(true as const),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "JjStatus.refreshUpstream",
                command: "jj",
                cwd,
                detail: "Background Jujutsu fetch failed.",
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

    const localStatus: JjStatusOps["localStatus"] = Effect.fn("JjStatus.localStatus")(
      function* (input) {
        // `ensureUsable` already composes the version probe with the colocation test, so the
        // "detected but unusable" reason the client renders comes from exactly one place.
        const reason = yield* driver.ensureUsable("JjStatus.localStatus", input.cwd).pipe(
          Effect.as(null),
          Effect.catch((error) =>
            Effect.succeed(error._tag === "VcsUnsupportedOperationError" ? error.detail : null),
          ),
        );
        if (reason !== null) {
          return {
            isRepo: true,
            vcs: { kind: "jj" as const, unsupportedReason: reason },
            ...EMPTY_LOCAL_STATUS,
          };
        }

        const readings = yield* Effect.all({
          change: driver.currentChange(input.cwd),
          segment: driver.currentSegment(input.cwd),
        }).pipe(Effect.option);

        if (readings._tag === "None") {
          return { isRepo: true, vcs: { kind: "jj" as const }, ...EMPTY_LOCAL_STATUS };
        }

        const refName = refNameFromSegment(readings.value.segment);
        const files = readings.value.change.fileStats
          .map((file) => ({
            path: file.path,
            insertions: file.linesAdded,
            deletions: file.linesRemoved,
          }))
          .sort((left, right) => left.path.localeCompare(right.path));

        const [provider, remoteNames, defaultBookmark] = yield* Effect.all([
          detectProvider(input.cwd),
          driver.listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => [] as const)),
          driver.resolveDefaultBookmark(input.cwd).pipe(Effect.orElseSucceed(() => null)),
        ]);

        return {
          isRepo: true,
          vcs: { kind: "jj" as const },
          ...(provider ? { sourceControlProvider: provider } : {}),
          hasPrimaryRemote: remoteNames.length > 0,
          isDefaultRef: refName !== null && refName === defaultBookmark,
          refName,
          hasWorkingTreeChanges: files.length > 0,
          workingTree: {
            files,
            insertions: files.reduce((total, file) => total + file.insertions, 0),
            deletions: files.reduce((total, file) => total + file.deletions, 0),
          },
        };
      },
    );

    const remoteStatus: JjStatusOps["remoteStatus"] = Effect.fn("JjStatus.remoteStatus")(
      function* (input, options) {
        const paths = yield* driver
          .ensureUsable("JjStatus.remoteStatus", input.cwd)
          .pipe(
            mapJjFailure(
              "JjStatus.remoteStatus",
              input.cwd,
              "This Jujutsu repository cannot be read.",
            ),
          );

        const segment = yield* driver
          .currentSegment(input.cwd)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<JjSegmentRow>));
        const refName = refNameFromSegment(segment);
        if (refName === null) {
          return {
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
            pr: null,
          };
        }

        const primaryRemote = yield* driver
          .resolvePrimaryRemoteName(input.cwd)
          .pipe(Effect.orElseSucceed(() => null));

        if (options?.refreshUpstream === true && primaryRemote !== null) {
          yield* Cache.get(
            upstreamRefreshCache,
            `${paths.mainWorkspaceRoot}\0${primaryRemote}`,
          ).pipe(Effect.ignore);
        }

        const upstream = yield* resolveUpstreamContext(driver, input.cwd, refName);
        const counts = yield* computeAheadBehindCounts(driver, input.cwd, {
          refName,
          primaryRemote,
          defaultBookmark: upstream.defaultBookmark,
          hasUpstream: upstream.hasUpstream,
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
          hasUpstream: upstream.hasUpstream,
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
      },
    );

    const status: JjStatusOps["status"] = Effect.fn("JjStatus.status")(function* (input) {
      const local = yield* localStatus(input);
      const remote = yield* remoteStatus(input);
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
