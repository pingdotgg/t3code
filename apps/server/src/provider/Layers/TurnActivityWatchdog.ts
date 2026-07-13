/**
 * Canonical provider-event liveness watchdog.
 *
 * ProviderService feeds every canonical runtime event through this tracker, so
 * Codex, ACP, Claude, and future providers share identical stall semantics.
 * The watchdog is surfacing-only: it never interrupts turns or kills sessions.
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import {
  DEFAULT_TURN_STALL_THRESHOLD_MS,
  TURN_STALL_POLL_INTERVAL_MS,
  readTurnStallThresholdMs,
} from "../turnReliabilityConfig.ts";

export interface TurnHealthTransition {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly turnId: TurnId;
  readonly state: "stalled" | "active";
  readonly lastActivityAt: string;
  readonly stalledForMs?: number;
}

export interface TurnActivitySnapshot {
  readonly lastActivityAt: string;
  readonly stalled: boolean;
  readonly activeTurnId?: TurnId;
}

export interface TurnActivityWatchdog {
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly getSnapshot: (threadId: ThreadId) => Effect.Effect<TurnActivitySnapshot | undefined>;
}

export interface TurnActivityWatchdogOptions {
  /** `0` disables stall transitions while retaining activity tracking. */
  readonly thresholdMs?: number;
  readonly pollIntervalMs?: number;
  readonly onTransition: (transition: TurnHealthTransition) => Effect.Effect<void>;
}

interface TrackedTurnActivity {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly activeTurnId?: TurnId;
  readonly lastActivityAt: string;
  readonly lastActivityAtMs: number;
  readonly stalled: boolean;
}

const isStoppedEvent = (event: ProviderRuntimeEvent): boolean =>
  event.type === "session.exited" ||
  (event.type === "session.state.changed" && event.payload.state === "stopped");

const isTurnEndedEvent = (event: ProviderRuntimeEvent): boolean =>
  event.type === "turn.completed" || event.type === "turn.aborted";

const PROGRESS_EVENT_PREFIXES = [
  "session.",
  "turn.",
  "item.",
  "content.",
  "request.",
  "user-input.",
  "task.",
  "hook.",
  "tool.",
  "thread.realtime.",
] as const;

const isProgressBearingEvent = (event: ProviderRuntimeEvent): boolean =>
  event.type === "files.persisted" ||
  PROGRESS_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix));

export const makeTurnActivityWatchdog = Effect.fn("makeTurnActivityWatchdog")(function* (
  options: TurnActivityWatchdogOptions,
): Effect.fn.Return<TurnActivityWatchdog, never, Scope.Scope> {
  const thresholdMs = Math.max(0, options.thresholdMs ?? readTurnStallThresholdMs());
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? TURN_STALL_POLL_INTERVAL_MS);
  const activityByThread = yield* Ref.make<ReadonlyMap<ThreadId, TrackedTurnActivity>>(new Map());

  const emit = (transition: TurnHealthTransition | undefined) =>
    transition === undefined
      ? Effect.void
      : options.onTransition(transition).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.turn.health.handler-failed", {
              threadId: transition.threadId,
              turnId: transition.turnId,
              state: transition.state,
              cause,
            }),
          ),
        );

  const observe = Effect.fn("TurnActivityWatchdog.observe")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.health") return;

    if (isStoppedEvent(event)) {
      yield* Ref.update(activityByThread, (current) => {
        if (!current.has(event.threadId)) return current;
        const next = new Map(current);
        next.delete(event.threadId);
        return next;
      });
      return;
    }
    if (!isProgressBearingEvent(event)) return;

    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);
    const transition = yield* Ref.modify(activityByThread, (current) => {
      const previous = current.get(event.threadId);
      const nextMap = new Map(current);
      const activeTurnId =
        event.type === "turn.started"
          ? event.turnId
          : isTurnEndedEvent(event)
            ? undefined
            : previous?.activeTurnId;

      const recovered =
        previous?.stalled === true && previous.activeTurnId !== undefined
          ? ({
              threadId: event.threadId,
              provider: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              turnId: previous.activeTurnId,
              state: "active",
              lastActivityAt: nowIso,
            } satisfies TurnHealthTransition)
          : undefined;

      nextMap.set(event.threadId, {
        provider: event.provider,
        ...(event.providerInstanceId !== undefined
          ? { providerInstanceId: event.providerInstanceId }
          : previous?.providerInstanceId !== undefined
            ? { providerInstanceId: previous.providerInstanceId }
            : {}),
        ...(activeTurnId !== undefined ? { activeTurnId } : {}),
        lastActivityAt: nowIso,
        lastActivityAtMs: nowMs,
        stalled: false,
      });
      return [recovered, nextMap] as const;
    });

    yield* emit(transition);
  });

  const checkOnce = Effect.gen(function* () {
    if (thresholdMs === 0) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const transitions = yield* Ref.modify(activityByThread, (current) => {
      const nextMap = new Map(current);
      const claimed: Array<TurnHealthTransition> = [];
      for (const [threadId, activity] of current) {
        if (activity.activeTurnId === undefined || activity.stalled) continue;
        const stalledForMs = nowMs - activity.lastActivityAtMs;
        if (stalledForMs < thresholdMs) continue;
        nextMap.set(threadId, { ...activity, stalled: true });
        claimed.push({
          threadId,
          provider: activity.provider,
          ...(activity.providerInstanceId !== undefined
            ? { providerInstanceId: activity.providerInstanceId }
            : {}),
          turnId: activity.activeTurnId,
          state: "stalled",
          lastActivityAt: activity.lastActivityAt,
          stalledForMs,
        });
      }
      return [claimed, nextMap] as const;
    });
    yield* Effect.forEach(transitions, emit, { discard: true });
  });

  if (thresholdMs > 0) {
    yield* checkOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.turn.health.poll-failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))),
      Effect.forkScoped,
    );
  }

  return {
    observe,
    getSnapshot: (threadId) =>
      Ref.get(activityByThread).pipe(
        Effect.map((entries) => {
          const activity = entries.get(threadId);
          return activity === undefined
            ? undefined
            : {
                lastActivityAt: activity.lastActivityAt,
                stalled: activity.stalled,
                ...(activity.activeTurnId !== undefined
                  ? { activeTurnId: activity.activeTurnId }
                  : {}),
              };
        }),
      ),
  } satisfies TurnActivityWatchdog;
});

export const TURN_ACTIVITY_WATCHDOG_DEFAULTS = {
  thresholdMs: DEFAULT_TURN_STALL_THRESHOLD_MS,
  pollIntervalMs: TURN_STALL_POLL_INTERVAL_MS,
} as const;
