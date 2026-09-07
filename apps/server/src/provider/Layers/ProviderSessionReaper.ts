import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const TURN_ACTIVITY_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.started",
  "turn.completed",
  "turn.aborted",
]);

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const parseOptionalTimestamp = (value: string | null | undefined): number | undefined => {
  if (value == null) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const recordTurnActivity = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
      if (!TURN_ACTIVITY_EVENT_TYPES.has(event.type)) {
        return Effect.void;
      }

      return DateTime.now.pipe(
        Effect.map(DateTime.formatIso),
        Effect.flatMap((lastSeenAt) =>
          runtimeRepository.touchByThreadId({
            threadId: event.threadId,
            lastSeenAt,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.activity-touch-failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause,
          }),
        ),
      );
    };

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        // Avoid the snapshot read for bindings that are fresh even before
        // considering projected turn activity.
        if (now - lastSeenMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs: now - lastSeenMs,
          });
          continue;
        }

        // `turn.completed` can clear activeTurnId before the independent
        // activity-touch fiber commits its timestamp update. Re-check the
        // authoritative projected turn timestamps before stopping so that
        // race cannot reap a session immediately after work finishes.
        const projectedTurnActivityMs = [
          parseOptionalTimestamp(thread?.latestTurn?.startedAt),
          parseOptionalTimestamp(thread?.latestTurn?.completedAt),
        ].reduce(
          (latest, timestamp) => (timestamp === undefined ? latest : Math.max(latest, timestamp)),
          lastSeenMs,
        );
        const idleDurationMs = now - projectedTurnActivityMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        // `lastSeenAt` is otherwise updated only by explicit session/turn
        // commands. A foreground turn may run longer than the inactivity
        // threshold, so refresh the binding at provider turn boundaries. This
        // gives the session a full idle window after the turn actually ends.
        yield* forkParked(Stream.runForEach(providerService.streamEvents, recordTurnActivity));

        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive().pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);
