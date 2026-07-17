import {
  GitCommandError,
  WORKTREE_BASE_FRESHNESS_WINDOW,
  WORKTREE_BASE_USABLE_HORIZON,
  type WorktreeBaseProvenance,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "./GitWorkflowService.ts";

export interface WorktreeBasePin {
  /** Commit SHA the new worktree is created from. */
  readonly commitSha: string;
  /** Remote-tracking ref the SHA was resolved from. */
  readonly remoteRefName: string;
  readonly provenance: WorktreeBaseProvenance;
  /** Time of the successful fetch backing this pin (null when unknown). */
  readonly fetchedAt: string | null;
}

export interface EnsureFreshRemoteResult {
  readonly fetchedAt: string | null;
  readonly fetchSucceeded: boolean;
}

/**
 * Plans the base commit for new worktree threads.
 *
 * Freshness ladder ("always current" without a blocking fetch on every send):
 * 1. A fetch of the repo's primary remote within {@link WORKTREE_BASE_FRESHNESS_WINDOW}
 *    counts as fresh — pin the remote-tracking commit immediately.
 * 2. Otherwise fetch now (deduped per repository: concurrent sends and the
 *    composer-open prefetch share one in-flight fetch).
 * 3. If that fetch fails but the last successful fetch is within
 *    {@link WORKTREE_BASE_USABLE_HORIZON}, proceed on the last-known remote
 *    commit with `provenance: "stale"` (fail-visible).
 * 4. With no usable fetch, fail closed — the caller surfaces the error and
 *    never silently falls back to a local ref.
 */
export class WorktreeBasePlanner extends Context.Service<
  WorktreeBasePlanner,
  {
    /**
     * Fetch the repository's primary remote unless a successful fetch is
     * already within the freshness window. Never fails: fetch failures are
     * reported through `fetchSucceeded` so composer-open prefetches are
     * fire-and-forget.
     */
    readonly ensureFreshRemote: (input: {
      readonly cwd: string;
    }) => Effect.Effect<EnsureFreshRemoteResult>;

    /**
     * Resolve the pinned base commit for a new worktree from `baseRef`,
     * applying the freshness ladder above.
     */
    readonly pinRemoteBase: (input: {
      readonly cwd: string;
      readonly baseRef: string;
    }) => Effect.Effect<WorktreeBasePin, GitCommandError>;
  }
>()("t3/git/WorktreeBasePlanner") {}

interface RepoFetchState {
  /** Completion time of the last successful fetch (ISO). */
  lastSuccessAt: string | null;
  /** Shared in-flight fetch so concurrent callers coalesce. */
  inFlight: Deferred.Deferred<boolean> | null;
}

export const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

  // Keyed by cwd. Bootstraps and the composer-open prefetch always pass the
  // project root, so a per-cwd key deduplicates the flows that matter.
  const fetchStateByCwd = new Map<string, RepoFetchState>();

  const getState = (cwd: string): RepoFetchState => {
    const existing = fetchStateByCwd.get(cwd);
    if (existing) {
      return existing;
    }
    const created: RepoFetchState = { lastSuccessAt: null, inFlight: null };
    fetchStateByCwd.set(cwd, created);
    return created;
  };

  const isWithin = (isoTime: string | null, window: Duration.Duration): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (isoTime === null) {
        return false;
      }
      const at = Date.parse(isoTime);
      if (Number.isNaN(at)) {
        return false;
      }
      const now = yield* Clock.currentTimeMillis;
      return now - at <= Duration.toMillis(window);
    });

  const runDedupedFetch = (cwd: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const state = getState(cwd);
      const existingInFlight = state.inFlight;
      if (existingInFlight) {
        return yield* Deferred.await(existingInFlight);
      }
      // Claim the slot synchronously (no suspension between the check above
      // and this assignment) so concurrent callers can't both start a fetch.
      const inFlight = Deferred.makeUnsafe<boolean>();
      state.inFlight = inFlight;
      return yield* gitWorkflow.fetchRemote({ cwd, remoteName: "origin" }).pipe(
        Effect.flatMap(() =>
          DateTime.now.pipe(
            Effect.map((now) => {
              state.lastSuccessAt = DateTime.formatIso(now);
              return true;
            }),
          ),
        ),
        Effect.catch((error) =>
          Effect.logDebug("worktree base fetch failed", {
            cwd,
            detail: error.message,
          }).pipe(Effect.map(() => false)),
        ),
        Effect.onExit((exit) => {
          state.inFlight = null;
          return Deferred.done(inFlight, Exit.isSuccess(exit) ? exit : Exit.succeed(false)).pipe(
            Effect.asVoid,
          );
        }),
      );
    });

  const ensureFreshRemote: WorktreeBasePlanner["Service"]["ensureFreshRemote"] = Effect.fn(
    "WorktreeBasePlanner.ensureFreshRemote",
  )(function* (input) {
    const state = getState(input.cwd);
    if (yield* isWithin(state.lastSuccessAt, WORKTREE_BASE_FRESHNESS_WINDOW)) {
      return { fetchedAt: state.lastSuccessAt, fetchSucceeded: true };
    }
    const fetchSucceeded = yield* runDedupedFetch(input.cwd);
    return { fetchedAt: state.lastSuccessAt, fetchSucceeded };
  });

  const pinRemoteBase: WorktreeBasePlanner["Service"]["pinRemoteBase"] = Effect.fn(
    "WorktreeBasePlanner.pinRemoteBase",
  )(function* (input) {
    const { fetchedAt, fetchSucceeded } = yield* ensureFreshRemote({ cwd: input.cwd });

    const resolvePin = (provenance: WorktreeBaseProvenance) =>
      gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd: input.cwd,
          refName: input.baseRef,
          fallbackRemoteName: "origin",
        })
        .pipe(
          Effect.map(
            (resolved): WorktreeBasePin => ({
              commitSha: resolved.commitSha,
              remoteRefName: resolved.remoteRefName,
              provenance,
              fetchedAt,
            }),
          ),
        );

    if (fetchSucceeded) {
      return yield* resolvePin("fresh");
    }

    // Fail-visible: the remote is unreachable, but a recent fetch means the
    // remote-tracking ref is still a sane base. Proceed with stale provenance.
    if (yield* isWithin(fetchedAt, WORKTREE_BASE_USABLE_HORIZON)) {
      return yield* resolvePin("stale");
    }

    // Fail closed: no usable remote data. The caller must not silently fall
    // back to a local ref — surfacing this error is the contract.
    return yield* new GitCommandError({
      operation: "WorktreeBasePlanner.pinRemoteBase",
      command: "fetch",
      cwd: input.cwd,
      detail: `Couldn't prepare a fresh worktree from ${input.baseRef}: the remote could not be reached and no recent fetch is available. Nothing has started and your checkout was not modified.`,
    });
  });

  return WorktreeBasePlanner.of({
    ensureFreshRemote,
    pinRemoteBase,
  });
});

export const layer = Layer.effect(WorktreeBasePlanner, make);
