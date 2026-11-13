// ACP session behaviour extracted from server/adapter.ts (runtimeLifecycle).

import { AgentScope, AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import { makeAcpMcpOverAcpBridge, type AcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";
import { type AcpAdapterV2RuntimeInput } from "./acpAdapterConfig.ts";
import { type AcpMcpContext } from "./acpThreadContext.ts";
import { type ThreadId } from "@t3tools/contracts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { AcpSessionCtx16 } from "./acpSessionContext.ts";

export const createAcpRuntimeLifecycle = (ctx: AcpSessionCtx16) => {
  const makeRuntimeMcpBridge = Effect.fnUntraced(function* (
    mcpContext: AcpMcpContext,
    scope: Scope.Scope,
  ) {
    if (mcpContext.endpoint === undefined || mcpContext.authorization === undefined) {
      return undefined;
    }
    const mcpBridge = yield* makeAcpMcpOverAcpBridge({
      endpoint: mcpContext.endpoint,
      authorization: mcpContext.authorization,
      allocateConnectionId: ctx.random.uuidV4(),
    });
    yield* Scope.addFinalizer(scope, mcpBridge.dispose);
    return mcpBridge;
  });
  const spawnAcpRuntime = Effect.fnUntraced(function* (
    threadId: ThreadId | null,
    resumeSessionId?: string,
  ) {
    if (ctx.runtimeScope !== undefined) {
      yield* Scope.close(ctx.runtimeScope, Exit.void);
    }
    ctx.runtimeScope = yield* Scope.make();
    const mcpContext = yield* ctx.readMcpContext(threadId);
    ctx.runtimeMcpBridge = yield* makeRuntimeMcpBridge(mcpContext, ctx.runtimeScope);
    const runtimeGeneration = yield* Ref.get(ctx.runtimeCallbackGeneration);
    ctx.runtime = yield* ctx.flavor
      .makeRuntime(ctx.makeRuntimeInput(runtimeGeneration, mcpContext, resumeSessionId))
      .pipe(
        Effect.provideService(Scope.Scope, ctx.runtimeScope),
        Effect.provideService(SecureRandom.SecureRandom, ctx.random),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ctx.childProcessSpawner),
        Effect.provideService(AgentScope, ctx.agentScope),
        Effect.provideService(AgentScopeThreadId, threadId ?? undefined),
      );
  });
  const startAcpRuntime = Effect.fnUntraced(function* (
    threadId: ThreadId | null,
    resumeSessionId?: string,
  ) {
    const startup = Effect.gen(function* () {
      yield* spawnAcpRuntime(threadId, resumeSessionId);
      yield* ctx.wireAcpRuntimeHandlers(ctx.runtime, yield* Ref.get(ctx.runtimeCallbackGeneration));
      return yield* ctx.runtime.start();
    });
    return yield* ctx.flavor.withRuntimeStartup?.(startup) ?? startup;
  });
  const restartAcpRuntime = Effect.fnUntraced(function* (threadId: ThreadId | null) {
    yield* spawnAcpRuntime(threadId);
    yield* ctx.wireAcpRuntimeHandlers(ctx.runtime, yield* Ref.get(ctx.runtimeCallbackGeneration));
  });
  const startReplacementAcpRuntime = Effect.fnUntraced(function* (
    threadId: ThreadId | null,
    commitSessionState: (
      replacement: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    ) => Effect.Effect<void>,
  ) {
    const previousScope = ctx.runtimeScope;
    const previousGeneration = yield* Ref.get(ctx.runtimeCallbackGeneration);
    yield* ctx.runtimeCallbackPermit.withPermit(ctx.awaitAdmittedNativeResponses);

    // Keep live callbacks active until replacement startup succeeds.
    const replacementGeneration = yield* ctx.allocateRuntimeCallbackGeneration;
    const replacementScope = yield* Scope.make();
    type CandidateLifecycle =
      | { readonly _tag: "Starting" }
      | { readonly _tag: "Terminated"; readonly error: EffectAcpErrors.AcpError }
      | { readonly _tag: "Committed" };
    const candidateLifecycle = yield* Ref.make<CandidateLifecycle>({ _tag: "Starting" });
    const handleCandidateTermination: AcpAdapterV2RuntimeInput["onTermination"] = (error) =>
      Ref.modify(
        candidateLifecycle,
        (current): readonly [Effect.Effect<void>, CandidateLifecycle] => {
          if (current._tag === "Committed") {
            return [ctx.handleRuntimeTerminationAtGeneration(replacementGeneration), current];
          }
          return [
            Effect.void,
            current._tag === "Terminated"
              ? current
              : ({ _tag: "Terminated", error } as const),
          ];
        },
      ).pipe(Effect.flatten);
    const stagedSessionUpdates: Array<EffectAcpSchema.SessionNotification> = [];
    let handleCandidateSessionUpdate: (
      notification: EffectAcpSchema.SessionNotification,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError> = (notification) =>
      Effect.sync(() => {
        stagedSessionUpdates.push(notification);
      });
    let replacementMcpBridge: AcpMcpOverAcpBridge | undefined;
    const startup = Effect.gen(function* () {
      const mcpContext = yield* ctx.readMcpContext(threadId);
      replacementMcpBridge = yield* makeRuntimeMcpBridge(mcpContext, replacementScope);
      const replacementRuntime = yield* ctx.flavor
        .makeRuntime(
          ctx.makeRuntimeInput(
            replacementGeneration,
            mcpContext,
            undefined,
            handleCandidateTermination,
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, replacementScope),
          Effect.provideService(SecureRandom.SecureRandom, ctx.random),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ctx.childProcessSpawner),
          Effect.provideService(AgentScope, ctx.agentScope),
          Effect.provideService(AgentScopeThreadId, threadId ?? undefined),
        );
      yield* replacementRuntime.handleSessionUpdate((notification) =>
        Effect.suspend(() => handleCandidateSessionUpdate(notification)),
      );
      yield* ctx.wireAcpRuntimeMcpHandlers(replacementRuntime, replacementMcpBridge);
      const started = yield* replacementRuntime.start();
      return { replacementRuntime, started };
    });
    const replacementExit = yield* Effect.exit(
      (ctx.flavor.withRuntimeStartup?.(startup) ?? startup).pipe(
        Effect.onInterrupt(() =>
          Scope.close(replacementScope, Exit.void).pipe(Effect.ignore),
        ),
      ),
    );
    if (Exit.isFailure(replacementExit)) {
      yield* ctx.runtimeCallbackPermit.withPermit(
        ctx.quarantineNativeTransportAtGeneration(replacementGeneration),
      );
      yield* Scope.close(replacementScope, Exit.void).pipe(Effect.ignore);
      return yield* Effect.failCause(replacementExit.cause);
    }

    yield* ctx.runtimeCallbackPermit
      .withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* ctx.awaitAdmittedNativeResponses;
            yield* ctx.wireAcpRuntimeHandlers(
              replacementExit.value.replacementRuntime,
              replacementGeneration,
              {
                sessionUpdates: false,
                terminals: false,
                mcp: false,
                scope: replacementScope,
              },
            );
            const lifecycle = yield* Ref.modify(
              candidateLifecycle,
              (current): readonly [CandidateLifecycle, CandidateLifecycle] =>
                current._tag === "Terminated"
                  ? [current, current]
                  : [{ _tag: "Committed" }, { _tag: "Committed" }],
            );
            if (lifecycle._tag === "Terminated") {
              return yield* lifecycle.error;
            }
            yield* ctx.quarantineNativeTransportAtGeneration(previousGeneration);
            ctx.runtime = replacementExit.value.replacementRuntime;
            ctx.runtimeScope = replacementScope;
            ctx.runtimeMcpBridge = replacementMcpBridge;
            yield* Ref.set(ctx.runtimeCallbackGeneration, replacementGeneration);
            ctx.prepareTerminalEnvironment(
              yield* ctx.readMcpContext(threadId),
              replacementExit.value.started.sessionId,
            );
            yield* ctx.wireAcpRuntimeTerminalHandlers(replacementExit.value.replacementRuntime);
            yield* commitSessionState(replacementExit.value.started);
            while (true) {
              const buffered = stagedSessionUpdates.splice(0, stagedSessionUpdates.length);
              if (buffered.length === 0) {
                handleCandidateSessionUpdate = (notification) =>
                  ctx.projectAcpRuntimeSessionUpdate(replacementGeneration, notification);
                break;
              }
              yield* Effect.forEach(
                buffered,
                (notification) =>
                  ctx.projectAcpRuntimeSessionUpdateEffect(notification).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("failed to replay staged ACP session update", {
                        driver: ctx.driver,
                        cause,
                      }),
                    ),
                  ),
                { discard: true },
              );
            }
            yield* ctx.late.cancelPendingRuntimeRequests();
            if (previousScope !== undefined) {
              yield* Scope.close(previousScope, Exit.void).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("failed to close replaced ACP runtime scope", {
                    driver: ctx.driver,
                    cause,
                  }),
                ),
              );
            }
          }),
        ),
      )
      .pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.get(candidateLifecycle).pipe(
                Effect.flatMap((lifecycle) =>
                  lifecycle._tag === "Committed"
                    ? Effect.void
                    : Scope.close(replacementScope, Exit.void).pipe(Effect.ignore),
                ),
              )
            : Effect.void,
        ),
      );
    return replacementExit.value.started;
  });
  const commitReplacementSession = Effect.fn("AcpAdapterV2.commitReplacementSession")(
    function* (
      threadId: ThreadId | null,
      candidate: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    ) {
      ctx.rememberTerminalEnvironment(candidate.sessionId, yield* ctx.readMcpContext(threadId));
      yield* Ref.set(ctx.runtimeRestartRequired, false);
      yield* Ref.set(ctx.activeSessionId, candidate.sessionId);
      yield* ctx.setActiveSessionSetup(candidate);
      yield* Ref.set(ctx.activeSelection, null);
      yield* Ref.set(ctx.activeInteractionMode, null);
      yield* Ref.set(ctx.promptInstructionStates, new Map());
      yield* Ref.set(ctx.compactionMarkers, new Map());
      yield* Ref.set(ctx.providerTurns, new Map());
      yield* Ref.set(ctx.snapshot, {
        order: [],
        messages: new Map(),
        loadingRole: null,
        loadingMessageId: null,
        loadingIndex: 0,
      });
      yield* ctx.continuationPermit.withPermit(
        Effect.gen(function* () {
          yield* Ref.update(ctx.continuationGeneration, (value) => value + 1);
          yield* Ref.set(ctx.stoppedRunQuarantine, false);
          yield* Ref.set(ctx.wakeBuffer, []);
          yield* Ref.set(ctx.wakeReports, ctx.noWakeReports);
          yield* Ref.set(ctx.continuationRequested, false);
          yield* Ref.set(ctx.runningBackgroundTaskIds, new Set());
          yield* Ref.set(ctx.endedBackgroundTaskIds, new Set());
          yield* Ref.set(ctx.midTurnUnreportedCompletedTaskIds, new Set());
          yield* Ref.set(ctx.handledBackgroundTaskIdsInActiveTurn, new Set());
          yield* Ref.set(ctx.carryoverSubagents, null);
          yield* Ref.set(ctx.suppressPostSettleMonitorPrompt, false);
          yield* Ref.set(ctx.lastTurnRoute, null);
        }),
      );
    },
  );
  return {
    makeRuntimeMcpBridge,
    spawnAcpRuntime,
    startAcpRuntime,
    restartAcpRuntime,
    startReplacementAcpRuntime,
    commitReplacementSession,
  };
};
