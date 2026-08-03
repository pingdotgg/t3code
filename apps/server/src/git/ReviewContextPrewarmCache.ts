/**
 * ReviewContextPrewarmCache - lets a hover absorb the cost of a pull-request
 * review capture so the click that follows does not pay for it again.
 *
 * `gh pr view` + `gh pr diff` cost roughly 700ms of network, and they complete
 * before the review thread can be created, so the whole capture sits on the
 * critical path between clicking a pull request and seeing its thread.
 *
 * The parked capture is **single use**: exactly one claim consumes it. A pull
 * request number does not name an immutable patch — its head can be pushed at
 * any time — so a capture may only satisfy the click it was started for. It is
 * never left behind to answer a later review, and it is never consulted by
 * callers who need the diff as it is right now, such as the verifier that
 * anchors a finished review to what the reviewer actually inspected.
 *
 * Working-tree scopes are not parked at all. Their diff can change between
 * hover and click — a background agent writing files is enough — and no check
 * cheaper than the diff itself detects it, so they always capture fresh.
 *
 * @module ReviewContextPrewarmCache
 */
import { Deferred, Effect, Exit } from "effect";

import type { GitCommandError, GitResolveReviewChangesContextResult } from "@t3tools/contracts";

/**
 * How long a parked capture may still be claimed. This spans one hover-to-click
 * handoff, not a browsing session: the longer it stands, the more likely the
 * pull request's head has moved underneath it.
 */
export const REVIEW_CONTEXT_PREWARM_TTL_MS = 10_000;

/** Bounds the memory held by parked captures, which are up to 4MB each. */
export const REVIEW_CONTEXT_PREWARM_MAX_ENTRIES = 4;

type ReviewContextResult = GitResolveReviewChangesContextResult;

/**
 * The capture's outcome is the deferred's *success* value, so awaiting it can
 * only fail by the waiter's own interruption. A claim must never mistake the
 * capture's interruption for its own cancellation, nor the reverse.
 */
type CaptureExit = Exit.Exit<ReviewContextResult, GitCommandError>;

export interface ReviewContextPrewarmCacheShape {
  /**
   * Captures under `key` so a later `claim` can reuse it. Calls for a key that
   * is already parked are ignored, so a hover cannot stack `gh` invocations.
   */
  readonly prewarm: (
    key: string,
    capture: Effect.Effect<ReviewContextResult, GitCommandError>,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Consumes the capture parked under `key`, waiting for it when it is still
   * running, and falls back to `capture` when there is none or it did not
   * succeed.
   */
  readonly claim: (
    key: string | null,
    capture: Effect.Effect<ReviewContextResult, GitCommandError>,
  ) => Effect.Effect<ReviewContextResult, GitCommandError>;
}

interface CacheEntry {
  readonly startedAt: number;
  readonly exit: Deferred.Deferred<CaptureExit>;
}

/**
 * Builds the key for an input, or `null` when the input must always be captured
 * fresh because its diff can change while the user decides to click.
 */
export function reviewContextPrewarmKey(input: {
  readonly cwd: string;
  readonly scope: string;
  readonly pullRequestNumber?: number | undefined;
}): string | null {
  if (input.scope !== "pull-request" || input.pullRequestNumber === undefined) {
    return null;
  }
  return `${input.cwd}\u0000${input.pullRequestNumber}`;
}

export function makeReviewContextPrewarmCache(): ReviewContextPrewarmCacheShape {
  const entries = new Map<string, CacheEntry>();

  const drop = (key: string, entry: CacheEntry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };

  const isFresh = (entry: CacheEntry, now: number) =>
    now - entry.startedAt < REVIEW_CONTEXT_PREWARM_TTL_MS;

  const prewarm: ReviewContextPrewarmCacheShape["prewarm"] = (key, capture) =>
    Effect.gen(function* () {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const existing = entries.get(key);
      if (existing) {
        if (isFresh(existing, now)) return;
        drop(key, existing);
      }

      const entry: CacheEntry = { startedAt: now, exit: yield* Deferred.make<CaptureExit>() };
      entries.set(key, entry);
      if (entries.size > REVIEW_CONTEXT_PREWARM_MAX_ENTRIES) {
        const oldest = [...entries]
          .filter(([entryKey]) => entryKey !== key)
          .toSorted(([, left], [, right]) => left.startedAt - right.startedAt)[0];
        if (oldest) drop(oldest[0], oldest[1]);
      }

      yield* capture.pipe(
        // Always publishes an outcome, so a claim can never wait on a capture
        // that already stopped. One that did not succeed leaves nothing parked.
        Effect.onExit((exit: CaptureExit) =>
          Effect.sync(() => {
            if (!Exit.isSuccess(exit)) drop(key, entry);
          }).pipe(Effect.andThen(Deferred.succeed(entry.exit, exit))),
        ),
        Effect.asVoid,
      );
    });

  const claim: ReviewContextPrewarmCacheShape["claim"] = (key, capture) =>
    Effect.gen(function* () {
      if (key === null) return yield* capture;

      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const entry = entries.get(key);
      if (!entry) return yield* capture;

      // A capture answers one claim only: a pull request's head can move, so it
      // must never be left behind to serve a later review.
      drop(key, entry);
      if (!isFresh(entry, now)) return yield* capture;

      const exit = yield* Deferred.await(entry.exit);
      // A non-success here is the prewarm's outcome, not ours — its RPC caller
      // may simply have disconnected — so recapture instead of adopting it.
      return Exit.isSuccess(exit) ? exit.value : yield* capture;
    });

  return { prewarm, claim };
}
