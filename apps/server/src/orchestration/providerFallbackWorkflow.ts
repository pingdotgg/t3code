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
  readonly skipped: ReadonlyArray<ProviderFallbackSkip>;
}

interface ProviderFallbackLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
  generation: number;
  lastResult: ProviderFallbackAttemptResult | undefined;
}

const fallbackLocks = new Map<ThreadId, ProviderFallbackLockEntry>();
const fallbackTrialInstanceByThread = new Map<ThreadId, ProviderInstanceId>();

export function isProviderFallbackTrialInstance(
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
): boolean {
  return fallbackTrialInstanceByThread.get(threadId) === instanceId;
}

function clearFallbackTrialInstance(threadId: ThreadId, instanceId?: ProviderInstanceId) {
  return Effect.sync(() => {
    if (instanceId === undefined || fallbackTrialInstanceByThread.get(threadId) === instanceId) {
      fallbackTrialInstanceByThread.delete(threadId);
    }
  });
}

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

  const plan = planProviderFallback({
    settings,
    providers,
    currentInstanceId: input.failedInstanceId,
    modelSelection: input.modelSelection,
    requireCompatibleContinuation: input.requireCompatibleContinuation,
  });
  const skipped: ProviderFallbackSkip[] = [...plan.skipped];
  const originalSession = (yield* providerService.listSessions()).find(
    (session) => session.threadId === input.threadId,
  );
  let bindingChanged = false;
  let boundFallbackInstance: ProviderFallbackCandidate | undefined;

  const nextCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const appendOutcomeActivity = (outcome: {
    readonly kind: "provider.fallback.failed" | "provider.fallback.succeeded";
    readonly summary: string;
    readonly tone: "error" | "info";
    readonly toInstanceId?: ProviderInstanceId;
    readonly toDisplayName?: string;
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
              fromInstanceId: input.failedInstanceId,
              fromDisplayName: providerFallbackDisplayName(currentProvider),
              ...(outcome.toInstanceId ? { toInstanceId: outcome.toInstanceId } : {}),
              ...(outcome.toDisplayName ? { toDisplayName: outcome.toDisplayName } : {}),
              failureKind: input.failure.kind,
              detail: input.failure.message,
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
    yield* Effect.sync(() => {
      fallbackTrialInstanceByThread.set(input.threadId, candidate.instanceId);
    });
    const attempt = yield* Effect.gen(function* () {
      const started = yield* providerService.startSession(input.threadId, {
        threadId: input.threadId,
        provider: candidate.provider.driver,
        providerInstanceId: candidate.instanceId,
        ...(cwd ? { cwd } : {}),
        modelSelection: candidate.modelSelection,
        ...(input.requireCompatibleContinuation && originalSession?.resumeCursor !== undefined
          ? { resumeCursor: originalSession.resumeCursor }
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
      yield* clearFallbackTrialInstance(input.threadId, candidate.instanceId);
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
    yield* appendOutcomeActivity({
      kind: "provider.fallback.succeeded",
      summary: `Switched to ${candidate.displayName}`,
      tone: "info",
      toInstanceId: candidate.instanceId,
      toDisplayName: candidate.displayName,
    });
    return { switched: true, skipped } satisfies ProviderFallbackAttemptResult;
  }

  if (bindingChanged) {
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
        const originalModelSelection: ModelSelection = {
          ...thread.modelSelection,
          instanceId: originalInstanceId,
          ...(originalSession.model !== undefined ? { model: originalSession.model } : {}),
        };
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
  });
  return { switched: false, skipped } satisfies ProviderFallbackAttemptResult;
});

export const attemptProviderFallback = Effect.fn("attemptProviderFallback")(function* (
  input: ProviderFallbackAttemptInput,
) {
  return yield* withProviderFallbackLock(
    input.threadId,
    attemptProviderFallbackUnlocked(input).pipe(
      Effect.ensuring(clearFallbackTrialInstance(input.threadId)),
    ),
  );
});
