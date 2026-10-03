import {
  CommandId,
  EventId,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Ref, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeLiveness } from "../Services/ProviderRuntimeLiveness.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SETTLED_TURN_GRACE_MS = 30 * 1000;
const DEFAULT_SETTLED_TURN_HOLD_MS = 10 * 60 * 1000;
const LEGACY_RESTART_PROVIDER_SESSION_ERROR = "Provider session is no longer active.";
const PROVIDER_SESSION_LOST_ERROR = "Provider session was lost unexpectedly.";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function sessionKeepsTurnActive(
  session: ProviderSession | undefined,
  activeTurnId: string,
): boolean {
  if (!session) return false;
  return session.activeTurnId === activeTurnId;
}

/**
 * Why a projection/provider mismatch must not be treated as a lost session.
 *
 * `getReadModel()` reflects commands the single command worker has already
 * committed, while `listSessions()` reflects the adapter's in-memory session,
 * which flips to idle *before* the adapter emits the matching terminal event
 * (`finishTurn` clears `activeTurnId`, then emits `turn.completed`). The
 * runtime bus is bounded and applies backpressure, so the projection can trail
 * that terminal event by seconds under an event burst. Reaping on a bare
 * mismatch therefore interrupts healthy turns that already finished and shows
 * the user "Provider session was lost unexpectedly."
 *
 * Every hold is time-bounded. A projection that genuinely never converges — a
 * rejected terminal command, a snapshot restore — must not be able to disable
 * the reaper's only recovery path permanently just because the provider
 * reported the turn settled once.
 */
type MismatchHoldReason =
  | "provider_reported_turn_settled"
  | "provider_still_reporting"
  | "projection_advanced";

const mismatchHoldReason = (input: {
  readonly settledTurnAgeMs: number | null;
  readonly silenceDurationMs: number | null;
  readonly settledTurnGraceMs: number;
  readonly settledTurnHoldMs: number;
  readonly projectedActiveTurnId: string | null;
  readonly observedActiveTurnId: string;
}): MismatchHoldReason | null => {
  // The provider already gave this turn a terminal outcome, so the projection
  // is behind rather than wrong. Wait for the in-flight command, but only for
  // as long as that explanation stays plausible.
  if (input.settledTurnAgeMs !== null && input.settledTurnAgeMs < input.settledTurnHoldMs) {
    return "provider_reported_turn_settled";
  }
  // A terminal event for the active turn is probably still travelling. Adapters
  // update their session before emitting, so this closes that window.
  if (input.silenceDurationMs !== null && input.silenceDurationMs < input.settledTurnGraceMs) {
    return "provider_still_reporting";
  }
  // The turn the projection names changed while this sweep was deciding.
  if (input.projectedActiveTurnId !== input.observedActiveTurnId) return "projection_advanced";
  return null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findOrphanedBackgroundAgents(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }>,
) {
  const runningByTaskId = new Map<
    string,
    { readonly taskId: string; readonly name: string; readonly turnId: TurnId | null }
  >();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  for (const activity of ordered) {
    if (!isRecord(activity.payload)) continue;
    const taskId = typeof activity.payload.taskId === "string" ? activity.payload.taskId : null;
    if (taskId === null) continue;
    if (activity.kind === "task.started" && activity.payload.taskType === "background-agent") {
      runningByTaskId.set(taskId, {
        taskId,
        name: typeof activity.payload.name === "string" ? activity.payload.name : taskId,
        turnId: activity.turnId,
      });
      continue;
    }
    if (activity.kind === "task.completed") {
      runningByTaskId.delete(taskId);
    }
  }

  return [...runningByTaskId.values()];
}

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /**
   * How long the provider must have been silent for a thread before a
   * projection/provider mismatch is treated as a lost session rather than a
   * terminal event still in flight to the projection.
   */
  readonly settledTurnGraceMs?: number;
  /**
   * How long a provider-reported terminal outcome keeps excusing a
   * projection/provider mismatch. Bounds how long a converged-but-lagging
   * projection can hold off the reaper before it is treated as a genuine loss.
   */
  readonly settledTurnHoldMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runtimeLiveness = yield* ProviderRuntimeLiveness;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const settledTurnGraceMs = Math.max(
      0,
      options?.settledTurnGraceMs ?? DEFAULT_SETTLED_TURN_GRACE_MS,
    );
    const settledTurnHoldMs = Math.max(
      0,
      options?.settledTurnHoldMs ?? DEFAULT_SETTLED_TURN_HOLD_MS,
    );
    const startupSweepPending = yield* Ref.make(true);
    const startupReconciled = yield* Ref.make(false);
    const startupSweepIncludesInactive = yield* Ref.make(false);
    yield* Effect.logInfo("provider.session.reaper.configured", {
      inactivityThresholdMs,
      sweepIntervalMs,
      settledTurnGraceMs,
      settledTurnHoldMs,
    });

    const reconcileOrphanedBackgroundAgents = Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      let reconciledCount = 0;
      for (const thread of readModel.threads) {
        const orphanedAgents = findOrphanedBackgroundAgents(thread.activities);
        for (const agent of orphanedAgents) {
          const createdAt = new Date().toISOString();
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: serverCommandId("provider-session-reaper-orphaned-background-agent"),
            threadId: thread.id,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "info",
              kind: "task.completed",
              summary: `${agent.name} stopped`,
              payload: {
                taskId: agent.taskId,
                status: "stopped",
                detail: "Provider session ended before the background agent reported completion.",
              },
              turnId: agent.turnId,
              createdAt,
            },
            createdAt,
          });
          reconciledCount += 1;
        }
      }
      if (reconciledCount > 0) {
        yield* Effect.logWarning("provider.session.reaper.reconciled-background-agents", {
          reconciledCount,
        });
      }
    });

    const sweep = Effect.gen(function* () {
      const isStartupSweep = yield* Ref.get(startupSweepPending);
      const includeInactiveDuringStartup = yield* Ref.get(startupSweepIncludesInactive);
      // The liveness ledger also prunes on provider traffic, but a server with
      // one stuck thread and no other activity would never prune, so retention
      // would depend on unrelated threads. Drive it from the sweep instead.
      yield* runtimeLiveness.prune();
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
      const bindings = yield* directory.listBindings();
      const activeSessions = yield* providerService
        .listSessions()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.list-sessions-failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      const activeSessionsByThreadId =
        activeSessions === null
          ? null
          : new Map<ThreadId, ProviderSession>(
              activeSessions.map((session) => [session.threadId, session] as const),
            );
      const now = Date.now();
      let reapedCount = 0;

      for (const binding of bindings) {
        const thread = threadsById.get(binding.threadId);
        if (
          isStartupSweep &&
          thread?.session?.status === "interrupted" &&
          thread.session.activeTurnId === null &&
          thread.session.lastError === LEGACY_RESTART_PROVIDER_SESSION_ERROR
        ) {
          const updatedAt = new Date().toISOString();
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: serverCommandId("provider-session-reaper-clear-legacy-restart-error"),
            threadId: binding.threadId,
            session: {
              ...thread.session,
              lastError: null,
              updatedAt,
            },
            createdAt: updatedAt,
          });
          yield* Effect.logInfo("provider.session.reaper.cleared-legacy-restart-error", {
            threadId: binding.threadId,
            provider: binding.provider,
          });
          continue;
        }
        if (thread?.session?.activeTurnId != null) {
          if (activeSessionsByThreadId === null) {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn-reconcile", {
              threadId: binding.threadId,
              activeTurnId: thread.session.activeTurnId,
              reason: "active_sessions_unavailable",
            });
            continue;
          }
          const activeSession = activeSessionsByThreadId.get(binding.threadId);
          if (!sessionKeepsTurnActive(activeSession, thread.session.activeTurnId)) {
            const activeTurnId = thread.session.activeTurnId;
            const observation = yield* runtimeLiveness.observe(binding.threadId);
            const settledAtMs = observation?.settledTurns.get(activeTurnId);
            // Re-read the projection immediately before deciding: the sweep's
            // snapshot can already be stale, and reaping a thread whose active
            // turn changed is the exact failure this guard prevents.
            const currentActiveTurnId = (yield* orchestrationEngine.getReadModel()).threads.find(
              (candidate) => candidate.id === binding.threadId,
            )?.session?.activeTurnId;
            const settledTurnAgeMs =
              settledAtMs === undefined ? null : Math.max(0, now - settledAtMs);
            const providerSilenceDurationMs =
              observation === null ? null : Math.max(0, now - observation.lastEventAtMs);
            const holdReason = mismatchHoldReason({
              settledTurnAgeMs,
              silenceDurationMs: providerSilenceDurationMs,
              settledTurnGraceMs,
              settledTurnHoldMs,
              projectedActiveTurnId: currentActiveTurnId ?? null,
              observedActiveTurnId: activeTurnId,
            });
            if (holdReason !== null) {
              // Info, not Debug: the server defaults to Info, so a Debug hold is
              // invisible in server.log. A hold means the reaper deliberately did
              // not act on a thread the projection calls running, which is the
              // exact event someone debugging a stuck thread needs to see.
              yield* Effect.logInfo("provider.session.reaper.held-stale-active-turn", {
                threadId: binding.threadId,
                provider: binding.provider,
                activeTurnId,
                reason: holdReason,
                activeProviderSessionStatus: activeSession?.status ?? null,
                activeProviderSessionTurnId: activeSession?.activeTurnId ?? null,
                projectedActiveTurnId: currentActiveTurnId ?? null,
                providerSilenceDurationMs,
                settledTurnAgeMs,
              });
              continue;
            }
            const updatedAt = new Date().toISOString();
            const lastSeenMs = Date.parse(binding.lastSeenAt);
            const streamingAssistantMessages = thread.messages.filter(
              (message) =>
                message.role === "assistant" &&
                message.turnId === activeTurnId &&
                message.streaming,
            );
            yield* Effect.forEach(
              streamingAssistantMessages,
              (message) =>
                orchestrationEngine.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: serverCommandId(
                    "provider-session-reaper-stale-active-turn-assistant-complete",
                  ),
                  threadId: binding.threadId,
                  messageId: message.id,
                  turnId: activeTurnId,
                  createdAt: updatedAt,
                }),
              { discard: true },
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: serverCommandId("provider-session-reaper-stale-active-turn"),
              threadId: binding.threadId,
              session: {
                ...thread.session,
                status: "interrupted",
                activeTurnId: null,
                lastError: isStartupSweep ? null : PROVIDER_SESSION_LOST_ERROR,
                updatedAt,
              },
              createdAt: updatedAt,
            });
            yield* Effect.logWarning("provider.session.reaper.cleared-stale-active-turn", {
              threadId: binding.threadId,
              provider: binding.provider,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs: Number.isNaN(lastSeenMs) ? null : now - lastSeenMs,
              providerSilenceDurationMs,
              settledTurnAgeMs,
              activeProviderSessionStatus: activeSession?.status ?? null,
              activeProviderSessionTurnId: activeSession?.activeTurnId ?? null,
              reason: isStartupSweep ? "server_restart" : "provider_session_mismatch",
              finalizedAssistantMessageCount: streamingAssistantMessages.length,
            });
            continue;
          }
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
          });
          continue;
        }

        if (isStartupSweep && !includeInactiveDuringStartup) {
          continue;
        }

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

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
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
      if (activeSessionsByThreadId !== null) {
        yield* Ref.set(startupSweepPending, false);
      }
      return activeSessionsByThreadId !== null;
    });

    const runSweepSafely = (includeInactiveDuringStartup: boolean) =>
      Ref.set(startupSweepIncludesInactive, includeInactiveDuringStartup).pipe(
        Effect.andThen(sweep),
        Effect.catch((error: unknown) =>
          Effect.logWarning("provider.session.reaper.sweep-failed", {
            error,
          }).pipe(Effect.as(false)),
        ),
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("provider.session.reaper.sweep-defect", {
            defect,
          }).pipe(Effect.as(false)),
        ),
      );

    const reconcileStartup: ProviderSessionReaperShape["reconcileStartup"] = Effect.gen(
      function* () {
        yield* reconcileOrphanedBackgroundAgents.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.background-reconcile-failed", { cause }),
          ),
        );
        yield* runSweepSafely(false).pipe(
          Effect.timeoutOption("30 seconds"),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.logWarning("provider.session.reaper.startup-sweep-timed-out").pipe(
                  Effect.as(false),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.repeat({
            while: (reconciled) => !reconciled,
            schedule: Schedule.spaced("100 millis"),
          }),
        );
        yield* Ref.set(startupReconciled, true);
      },
    );

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(startupReconciled))) {
          yield* reconcileOrphanedBackgroundAgents.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.background-reconcile-failed", { cause }),
            ),
          );
        }
        yield* Effect.forkScoped(
          runSweepSafely(true).pipe(
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      reconcileStartup,
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
