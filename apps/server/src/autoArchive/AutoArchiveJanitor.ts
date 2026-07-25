/**
 * Periodically archives threads that have been settled longer than
 * `ServerSettings.autoArchiveSettledAfter`. Disabled when that setting is
 * `null` (the default).
 *
 * "Settled" here means the server-observable subset of the client's
 * `effectiveSettled` classification: an explicit `thread.settle` override
 * (timed from `settledAt`), or simple inactivity (timed from the last user
 * message / turn timestamp). Merge- and close-driven settle is a
 * client-side classification over VCS pull-request state that the server
 * never sees; those threads are still caught by the inactivity rule once
 * they go quiet.
 */
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { OrchestrationSessionStatus, ServerSettings, ThreadId } from "@t3tools/contracts";

/** How often the janitor sweeps for archivable threads. */
export const AUTO_ARCHIVE_POLL_INTERVAL = Duration.minutes(10);

/**
 * Structural subset of `OrchestrationThreadShell` the eligibility check
 * reads. Kept minimal (rather than `Pick<OrchestrationThreadShell, …>`) so
 * tests can build snapshots without fabricating full session/turn rows.
 */
export interface AutoArchiveThreadSnapshot {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly settledOverride?: "settled" | "active" | null | undefined;
  readonly settledAt?: string | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
  readonly latestUserMessageAt: string | null;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

const lastActivityAt = (thread: AutoArchiveThreadSnapshot): string | null => {
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }
  return latest;
};

/**
 * Mirrors the activity blockers of the client `effectiveSettled`/`canSettle`
 * twins: pending approvals or user input and a live session keep a thread
 * visible no matter how old it is. The queued-turn-start blocker needs no
 * explicit check here — a just-sent message IS the last activity, so it
 * cannot be older than the (hours/days-scale) archive window.
 */
export function isAutoArchiveEligible(
  thread: AutoArchiveThreadSnapshot,
  options: { readonly nowMs: number; readonly windowMs: number },
): boolean {
  if (thread.archivedAt != null) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  // The explicit keep-active pin suppresses auto-archive until real activity
  // clears it server-side.
  if (thread.settledOverride === "active") return false;

  const settledSince =
    thread.settledOverride === "settled" && thread.settledAt != null
      ? thread.settledAt
      : lastActivityAt(thread);
  if (settledSince === null) return false;
  const settledSinceMs = Date.parse(settledSince);
  // A malformed timestamp must never cause a surprise archive.
  if (Number.isNaN(settledSinceMs)) return false;

  return options.nowMs - settledSinceMs >= options.windowMs;
}

export class AutoArchiveJanitor extends Context.Service<
  AutoArchiveJanitor,
  {
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/autoArchive/AutoArchiveJanitor") {}

export interface AutoArchiveJanitorDeps {
  readonly getSettings: Effect.Effect<Pick<ServerSettings, "autoArchiveSettledAfter">, unknown>;
  readonly listThreads: Effect.Effect<ReadonlyArray<AutoArchiveThreadSnapshot>, unknown>;
  readonly archiveThread: (threadId: ThreadId) => Effect.Effect<void, unknown>;
}

export const make = (deps: AutoArchiveJanitorDeps) =>
  Effect.sync(() => {
    const fiberRef = { current: null as Fiber.Fiber<void, never> | null };

    const tick: AutoArchiveJanitor["Service"]["tick"] = Effect.gen(function* () {
      const settings = yield* deps.getSettings.pipe(
        Effect.orElseSucceed(() => ({ autoArchiveSettledAfter: null })),
      );
      const window = settings.autoArchiveSettledAfter;
      if (window === null) {
        return;
      }
      const windowMs = Duration.toMillis(window);

      const threads = yield* deps.listThreads.pipe(Effect.orElseSucceed(() => []));
      const nowMs = yield* Clock.currentTimeMillis;
      for (const thread of threads) {
        if (!isAutoArchiveEligible(thread, { nowMs, windowMs })) {
          continue;
        }
        // One failing archive must not block the rest of the sweep.
        yield* deps.archiveThread(thread.id).pipe(Effect.orElseSucceed(() => undefined));
      }
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.asVoid,
    );

    const start: AutoArchiveJanitor["Service"]["start"] = Effect.gen(function* () {
      if (fiberRef.current) {
        return;
      }
      const fiber = yield* Effect.forkDetach(
        Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(AUTO_ARCHIVE_POLL_INTERVAL)))),
      );
      fiberRef.current = fiber as Fiber.Fiber<void, never>;
    });

    const stop: AutoArchiveJanitor["Service"]["stop"] = Effect.gen(function* () {
      if (!fiberRef.current) {
        return;
      }
      yield* Fiber.interrupt(fiberRef.current).pipe(
        Effect.asVoid,
        Effect.orElseSucceed(() => undefined),
      );
      fiberRef.current = null;
    });

    return AutoArchiveJanitor.of({ tick, start, stop });
  });

export const layer = (deps: AutoArchiveJanitorDeps) => Layer.effect(AutoArchiveJanitor, make(deps));
