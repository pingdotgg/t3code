import { CommandId, type ProviderSession, type ThreadId } from "@t3tools/contracts";
import { Duration, Effect, Layer, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVE_TURN_THRESHOLD_MS = 2 * 60 * 60 * 1000;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function sessionKeepsTurnActive(
  session: ProviderSession | undefined,
  activeTurnId: string,
): boolean {
  if (!session) return false;
  return session.activeTurnId === activeTurnId;
}

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly activeTurnThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const activeTurnThresholdMs = Math.max(
      1,
      options?.activeTurnThresholdMs ?? DEFAULT_ACTIVE_TURN_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
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
        if (thread?.session?.activeTurnId != null) {
          const lastSeenMs = Date.parse(binding.lastSeenAt);
          const activeTurnAgeMs = Number.isNaN(lastSeenMs) ? null : now - lastSeenMs;
          const hasExceededActiveTurnThreshold =
            activeTurnAgeMs !== null && activeTurnAgeMs >= activeTurnThresholdMs;
          if (activeSessionsByThreadId === null) {
            if (!hasExceededActiveTurnThreshold) {
              yield* Effect.logDebug("provider.session.reaper.skipped-active-turn-reconcile", {
                threadId: binding.threadId,
                activeTurnId: thread.session.activeTurnId,
                reason: "active_sessions_unavailable",
              });
              continue;
            }
          }
          const activeSession = activeSessionsByThreadId?.get(binding.threadId);
          if (
            hasExceededActiveTurnThreshold ||
            !sessionKeepsTurnActive(activeSession, thread.session.activeTurnId)
          ) {
            const updatedAt = new Date().toISOString();
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: serverCommandId("provider-session-reaper-stale-active-turn"),
              threadId: binding.threadId,
              session: {
                ...thread.session,
                status: "interrupted",
                activeTurnId: null,
                lastError: hasExceededActiveTurnThreshold
                  ? "Provider turn exceeded the maximum active duration."
                  : "Provider session is no longer active.",
                updatedAt,
              },
              createdAt: updatedAt,
            });
            yield* Effect.logWarning("provider.session.reaper.cleared-stale-active-turn", {
              threadId: binding.threadId,
              provider: binding.provider,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs: activeTurnAgeMs,
              activeProviderSessionStatus: activeSession?.status ?? null,
              activeProviderSessionTurnId: activeSession?.activeTurnId ?? null,
              reason: hasExceededActiveTurnThreshold
                ? "active_turn_threshold"
                : "provider_session_mismatch",
            });
            continue;
          }
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
          });
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
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
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
          activeTurnThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
