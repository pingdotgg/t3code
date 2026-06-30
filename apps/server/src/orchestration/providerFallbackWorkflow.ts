import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationSession,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import {
  planProviderFallback,
  providerFallbackDisplayName,
  type ProviderFallbackCandidate,
  type ProviderFallbackFailure,
  type ProviderFallbackSkip,
} from "../provider/providerFallback.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  beginProviderFallbackChain,
  completeProviderFallbackChain,
  markProviderFallbackInstanceAttempted,
} from "./providerFallbackChain.ts";
import {
  beginProviderFallbackTrial,
  completeProviderFallbackTrial,
  rejectPendingProviderFallbackTrials,
  type ProviderFallbackTrialToken,
} from "./providerFallbackTrialGate.ts";

export interface ProviderFallbackAttemptInput {
  readonly threadId: ThreadId;
  readonly failedInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly sendTurnInput: ProviderSendTurnInput;
  readonly failure: ProviderFallbackFailure;
  readonly requireCompatibleContinuation: boolean;
  readonly createdAt: string;
}

export interface ProviderFallbackAttemptResult {
  readonly switched: boolean;
  readonly restoredOriginalInstance?: boolean;
  readonly skipped: ReadonlyArray<ProviderFallbackSkip>;
}

interface ProviderFallbackLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
  generation: number;
  lastResult: ProviderFallbackAttemptResult | undefined;
}

const fallbackLocks = new Map<ThreadId, ProviderFallbackLockEntry>();

function withProviderFallbackLock<E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<ProviderFallbackAttemptResult, E, R>,
): Effect.Effect<ProviderFallbackAttemptResult, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const existing = fallbackLocks.get(threadId);
      if (existing) {
        existing.users += 1;
        return { entry: existing, observedGeneration: existing.generation };
      }
      const entry: ProviderFallbackLockEntry = {
        semaphore: Semaphore.makeUnsafe(1),
        users: 1,
        generation: 0,
        lastResult: undefined,
      };
      fallbackLocks.set(threadId, entry);
      return { entry, observedGeneration: 0 };
    }),
    ({ entry, observedGeneration }) =>
      entry.semaphore.withPermits(1)(
        Effect.gen(function* () {
          if (entry.generation !== observedGeneration && entry.lastResult !== undefined) {
            return entry.lastResult;
          }
          const result = yield* effect;
          entry.generation += 1;
          entry.lastResult = result;
          return result;
        }),
      ),
    ({ entry }) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0 && fallbackLocks.get(threadId) === entry) {
          fallbackLocks.delete(threadId);
        }
      }),
  );
}

function formatFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function sessionStatus(status: "connecting" | "ready" | "running" | "error" | "closed") {
  switch (status) {
    case "connecting":
      return "starting" as const;
    case "running":
      return "running" as const;
    case "error":
      return "error" as const;
    case "closed":
      return "stopped" as const;
    case "ready":
      return "ready" as const;
  }
}

const attemptProviderFallbackUnlocked = Effect.fn("attemptProviderFallbackUnlocked")(function* (
  input: ProviderFallbackAttemptInput,
) {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const providerService = yield* ProviderService;
  const settingsService = yield* ServerSettingsService;

  const settings = yield* settingsService.getSettings;
  if (!settings.providerFallback.enabled) {
    return { switched: false, skipped: [] } satisfies ProviderFallbackAttemptResult;
  }

  const thread = Option.getOrUndefined(yield* projection.getThreadDetailById(input.threadId));
  if (!thread) return { switched: false, skipped: [] } satisfies ProviderFallbackAttemptResult;
  const project = Option.getOrUndefined(yield* projection.getProjectShellById(thread.projectId));
  const cwd = resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] });
  const providers = yield* providerRegistry.getProviders;
  const currentProvider = providers.find(
    (provider) => provider.instanceId === input.failedInstanceId,
  );
  if (!currentProvider) {
    return { switched: false, skipped: [] } satisfies ProviderFallbackAttemptResult;
  }

  const activeSession = (yield* providerService.listSessions()).find(
    (session) => session.threadId === input.threadId,
  );
  const fallbackChain = beginProviderFallbackChain(input.threadId, input.failedInstanceId, {
    instanceId: input.failedInstanceId,
    displayName: providerFallbackDisplayName(currentProvider),
    failure: input.failure,
    modelSelection: input.modelSelection,
    session: activeSession,
  });

  const plan = planProviderFallback({
    settings,
    providers,
    currentInstanceId: input.failedInstanceId,
    modelSelection: input.modelSelection,
    requireCompatibleContinuation: input.requireCompatibleContinuation,
    excludedInstanceIds: fallbackChain.attemptedInstanceIds,
  });
  const skipped: ProviderFallbackSkip[] = [...plan.skipped];
  let bindingChanged = false;
  let restoredOriginalInstance = false;
  let boundFallbackInstance: ProviderFallbackCandidate | undefined;
  let currentTrialToken: ProviderFallbackTrialToken | undefined;

  const nextCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const appendOutcomeActivity = (outcome: {
    readonly kind: "provider.fallback.failed" | "provider.fallback.succeeded";
    readonly summary: string;
    readonly tone: "error" | "info";
    readonly toInstanceId?: ProviderInstanceId;
    readonly toDisplayName?: string;
    readonly useOriginalFailure?: boolean;
  }) =>
    Effect.all({ commandId: nextCommandId(outcome.kind), eventId: crypto.randomUUIDv4 }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: EventId.make(eventId),
            tone: outcome.tone,
            kind: outcome.kind,
            summary: outcome.summary,
            payload: {
              fromInstanceId: outcome.useOriginalFailure
                ? fallbackChain.origin.instanceId
                : input.failedInstanceId,
              fromDisplayName: outcome.useOriginalFailure
                ? fallbackChain.origin.displayName
                : providerFallbackDisplayName(currentProvider),
              ...(outcome.toInstanceId ? { toInstanceId: outcome.toInstanceId } : {}),
              ...(outcome.toDisplayName ? { toDisplayName: outcome.toDisplayName } : {}),
              failureKind: outcome.useOriginalFailure
                ? fallbackChain.origin.failure.kind
                : input.failure.kind,
              detail: outcome.useOriginalFailure
                ? fallbackChain.origin.failure.message
                : input.failure.message,
              ...(outcome.useOriginalFailure ? { restoredOriginalInstance: true } : {}),
              skipped,
            },
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );
  const stopFallbackSessionAndProject = Effect.fn("stopFallbackSessionAndProject")(function* () {
    const bound = boundFallbackInstance;
    yield* providerService.stopSession({ threadId: input.threadId }).pipe(Effect.ignore);
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: yield* nextCommandId("provider-fallback-stop"),
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "stopped",
        providerName: bound?.provider.driver ?? currentProvider.driver,
        providerInstanceId: bound?.instanceId ?? input.failedInstanceId,
        runtimeMode: input.runtimeMode,
        activeTurnId: null,
        lastError: input.failure.message,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  for (const candidate of plan.candidates) {
    markProviderFallbackInstanceAttempted(input.threadId, candidate.instanceId);
    currentTrialToken = yield* beginProviderFallbackTrial(input.threadId, candidate.instanceId);
    const attempt = yield* Effect.gen(function* () {
      const started = yield* providerService.startSession(input.threadId, {
        threadId: input.threadId,
        provider: candidate.provider.driver,
        providerInstanceId: candidate.instanceId,
        ...(cwd ? { cwd } : {}),
        modelSelection: candidate.modelSelection,
        ...(input.requireCompatibleContinuation && activeSession?.resumeCursor !== undefined
          ? { resumeCursor: activeSession.resumeCursor }
          : {}),
        runtimeMode: input.runtimeMode,
      });
      bindingChanged = true;
      boundFallbackInstance = candidate;
      const turn = yield* providerService.sendTurn({
        ...input.sendTurnInput,
        modelSelection: candidate.modelSelection,
      });
      return { started, turn };
    }).pipe(Effect.result);

    if (attempt._tag === "Failure") {
      yield* completeProviderFallbackTrial(currentTrialToken, "reject");
      currentTrialToken = undefined;
      skipped.push({
        instanceId: candidate.instanceId,
        displayName: candidate.displayName,
        reason: formatFailure(attempt.failure),
      });
      continue;
    }

    const { started, turn } = attempt.success;
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: yield* nextCommandId("provider-fallback-model"),
      threadId: input.threadId,
      modelSelection: candidate.modelSelection,
    });
    const session: OrchestrationSession = {
      threadId: input.threadId,
      status: "running",
      providerName: started.provider,
      providerInstanceId: candidate.instanceId,
      runtimeMode: input.runtimeMode,
      activeTurnId: turn.turnId,
      lastError: null,
      updatedAt: input.createdAt,
    };
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: yield* nextCommandId("provider-fallback-session"),
      threadId: input.threadId,
      session,
      createdAt: input.createdAt,
    });
    yield* completeProviderFallbackTrial(currentTrialToken, "accept");
    currentTrialToken = undefined;
    yield* appendOutcomeActivity({
      kind: "provider.fallback.succeeded",
      summary: `Switched to ${candidate.displayName}`,
      tone: "info",
      toInstanceId: candidate.instanceId,
      toDisplayName: candidate.displayName,
    });
    return { switched: true, skipped } satisfies ProviderFallbackAttemptResult;
  }

  const originalSession = fallbackChain.origin.session;
  const shouldRestoreOriginalInstance =
    bindingChanged || fallbackChain.origin.instanceId !== input.failedInstanceId;
  if (shouldRestoreOriginalInstance) {
    if (originalSession) {
      const originalInstanceId = originalSession.providerInstanceId;
      if (originalInstanceId === undefined) {
        skipped.push({
          instanceId: input.failedInstanceId,
          displayName: providerFallbackDisplayName(currentProvider),
          reason: "Could not restore the original session because its instance id is missing.",
        });
        yield* stopFallbackSessionAndProject();
      } else {
        const originalModelSelection: ModelSelection = fallbackChain.origin.modelSelection;
        const restored = yield* providerService
          .startSession(input.threadId, {
            threadId: input.threadId,
            provider: originalSession.provider,
            providerInstanceId: originalInstanceId,
            ...(cwd ? { cwd } : {}),
            modelSelection: originalModelSelection,
            ...(originalSession.resumeCursor !== undefined
              ? { resumeCursor: originalSession.resumeCursor }
              : {}),
            runtimeMode: input.runtimeMode,
          })
          .pipe(Effect.result);
        if (restored._tag === "Success") {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: yield* nextCommandId("provider-fallback-restore-model"),
            threadId: input.threadId,
            modelSelection: originalModelSelection,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: yield* nextCommandId("provider-fallback-restore"),
            threadId: input.threadId,
            session: {
              threadId: input.threadId,
              status: sessionStatus(restored.success.status),
              providerName: restored.success.provider,
              providerInstanceId: originalInstanceId,
              runtimeMode: input.runtimeMode,
              activeTurnId: null,
              lastError: input.failure.message,
              updatedAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          const attemptedOriginSkip = skipped.findIndex(
            (entry) =>
              entry.instanceId === originalInstanceId &&
              entry.reason ===
                "This instance was already attempted during the current fallback chain.",
          );
          if (attemptedOriginSkip >= 0) skipped.splice(attemptedOriginSkip, 1);
          restoredOriginalInstance = true;
        } else {
          skipped.push({
            instanceId: originalInstanceId,
            displayName: String(originalInstanceId),
            reason: `Could not restore the original instance: ${formatFailure(restored.failure)}`,
          });
          yield* stopFallbackSessionAndProject();
        }
      }
    } else {
      yield* stopFallbackSessionAndProject();
    }
  }

  yield* appendOutcomeActivity({
    kind: "provider.fallback.failed",
    summary: "Automatic provider fallback failed",
    tone: "error",
    useOriginalFailure: restoredOriginalInstance,
  });
  completeProviderFallbackChain(input.threadId);
  return {
    switched: false,
    restoredOriginalInstance,
    skipped,
  } satisfies ProviderFallbackAttemptResult;
});

export const attemptProviderFallback = Effect.fn("attemptProviderFallback")(function* (
  input: ProviderFallbackAttemptInput,
) {
  return yield* withProviderFallbackLock(
    input.threadId,
    attemptProviderFallbackUnlocked(input).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          completeProviderFallbackChain(input.threadId);
        }),
      ),
      Effect.ensuring(rejectPendingProviderFallbackTrials(input.threadId)),
    ),
  );
});
