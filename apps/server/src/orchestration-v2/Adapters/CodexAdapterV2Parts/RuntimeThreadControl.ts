import { pipe } from "effect/Function";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { parseGoalCommand } from "@t3tools/contracts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, CODEX_THREAD_IN_USE_MESSAGE, canReuseCodexContextUsage, codexTimestamp, isCodexActiveWriterError, toProtocolError } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { getNativeThreadId, isDescendantCodexTurn, providerThreadFromCodexThread } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { codexThreadRuntimeParams, decodeCodexResumeMetadata } from "../CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";
import type { ProjectGeneratedImagesPart } from "./ProjectGeneratedImages.ts";
import type { MakeRootTerminalEventPart } from "./MakeRootTerminalEvent.ts";
import type { FinalizeCodexTurnPart } from "./FinalizeCodexTurn.ts";
import type { RetryCapacityFailurePart } from "./RetryCapacityFailure.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart & MakeRootTerminalEventPart & FinalizeCodexTurnPart & RetryCapacityFailurePart;

export const installRuntimeThreadControl = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, adapterOptions, capacityContinuations, client, ensureInitialized, events, heldGoalTurn, idAllocator, imageTurns, input, latestRunTurnId, mcpSessions, pendingMcpAppCaptures, pendingRootTurns, readMcpSession, resumeNativeThread, runGoalCommand, runningCommandItemsByTurn, runningDynamicToolsByTurn, session, sessionApprovals, settledTurns, startNativeTurn, subagentThreads, toCodexInput, turnHasRetainedBackgroundWork } = deps;

const runtimeThreadControl: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "instanceId" | "driver" | "providerSessionId" | "providerSession" | "events" | "canReuseContextUsage" | "hasPendingBackgroundWork" | "hasPendingBackgroundWorkForThread" | "ensureThread" | "resumeThread" | "compactThread" | "injectHistory" | "startTurn" | "steerTurn" | "unloadThread"> = {
        instanceId: adapterOptions.instanceId,
        driver: CODEX_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromEffectRepeat(Queue.take(events)),
        canReuseContextUsage: canReuseCodexContextUsage,
        // Idle release can beat delayed subagent resumes: Codex reports them completed between turns with no resume-expected signal.
        hasPendingBackgroundWork: Effect.gen(function* () {
          for (const items of (yield* Ref.get(runningCommandItemsByTurn)).values()) {
            if (items.size > 0) {
              return true;
            }
          }
          for (const items of (yield* Ref.get(runningDynamicToolsByTurn)).values()) {
            if (items.size > 0) {
              return true;
            }
          }
          if ((yield* Ref.get(pendingMcpAppCaptures)).size > 0) {
            return true;
          }
          for (const state of imageTurns.values()) {
            if (state.running.size > 0 || state.saved.size > 0) return true;
          }
          for (const subagent of (yield* Ref.get(subagentThreads)).values()) {
            if (subagent.task.status === "running") {
              return true;
            }
          }
          return false;
        }),
        hasPendingBackgroundWorkForThread: Effect.fn(
          "CodexAdapterV2.hasPendingBackgroundWorkForThread",
        )(function* (providerThread) {
          const contexts = [
            ...(yield* Ref.get(activeTurns)).values(),
            ...(yield* Ref.get(settledTurns)).values(),
          ];
          const roots = contexts.filter(
            (context) => context.providerThread.id === providerThread.id,
          );
          for (const context of contexts) {
            if (!roots.some((root) => context === root || isDescendantCodexTurn(context, root)))
              continue;
            if (yield* turnHasRetainedBackgroundWork(context.nativeTurnId)) return true;
            if (
              context.subagent !== null &&
              (yield* Ref.get(activeTurns)).has(context.nativeTurnId)
            )
              return true;
          }
          return false;
        }),
        ensureThread: (threadInput) =>
          ensureInitialized.pipe(
            Effect.andThen(mcpSessions.read(threadInput.threadId)),
            Effect.flatMap((mcpSession) =>
              client.request(
                "thread/start",
                codexThreadRuntimeParams({
                  threadId: threadInput.threadId,
                  mcpSession,
                  modelSelection: threadInput.modelSelection,
                  runtimePolicy: threadInput.runtimePolicy,
                }),
              ),
            ),
            Effect.map((response): OrchestrationV2ProviderThread =>
              providerThreadFromCodexThread({
                appThreadId: threadInput.threadId,
                idAllocator,
                ownerNodeId: null,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                thread: response.thread,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: CODEX_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: Effect.fn("CodexAdapterV2.resumeThread")(
          function* (threadInput) {
            const nativeThreadId = yield* getNativeThreadId(threadInput.providerThread);
            const appThreadId = threadInput.threadId ?? threadInput.providerThread.appThreadId;
            const resume = resumeNativeThread(nativeThreadId, {
              excludeTurns: true,
              ...codexThreadRuntimeParams({
                threadId: appThreadId,
                mcpSession: yield* readMcpSession(appThreadId),
                ...(threadInput.modelSelection === undefined
                  ? {}
                  : { modelSelection: threadInput.modelSelection }),
                ...(threadInput.runtimePolicy === undefined
                  ? {}
                  : { runtimePolicy: threadInput.runtimePolicy }),
              }),
            });
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(resume),
              Effect.flatMap(decodeCodexResumeMetadata),
            );
            return {
              ...threadInput.providerThread,
              providerSessionId: input.providerSessionId,
              providerInstanceId: adapterOptions.instanceId,
              status: "idle",
              nativeThreadRef: {
                driver: CODEX_PROVIDER,
                nativeId: response.thread.id,
                strength: "strong",
              },
              nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
              updatedAt: codexTimestamp(response.thread.updatedAt),
            } satisfies OrchestrationV2ProviderThread;
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isCodexActiveWriterError(cause)
                  ? new ProviderAdapter.ProviderAdapterThreadInUseError({
                      driver: CODEX_PROVIDER,
                      providerThreadId: threadInput.providerThread.id,
                      detail: CODEX_THREAD_IN_USE_MESSAGE,
                      cause,
                    })
                  : new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: CODEX_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
              ),
            ),
        ),
        compactThread: Effect.fn("CodexAdapterV2.compactThread")(
          function* (turnInput) {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            yield* Ref.update(pendingRootTurns, (current) =>
              new Map(current).set(threadId, turnInput),
            );
            // Clear on interruption; a late turn/started must not be adopted after an interrupted start.
            yield* client.request("thread/compact/start", { threadId }).pipe(
              Effect.onError(() =>
                Ref.update(pendingRootTurns, (current) => {
                  const next = new Map(current);
                  next.delete(threadId);
                  return next;
                }),
              ),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CODEX_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        injectHistory: Effect.fn("CodexAdapterV2.injectHistory")(
          function* (input) {
            const threadId = yield* getNativeThreadId(input.providerThread);
            return yield* client
              .request("thread/inject_items", {
                threadId,
                items: historyResponseItems(input.messages, input.context),
              })
              .pipe(
                Effect.as(true),
                // Retry only unknown-method errors, which precede history mutation. Transport or payload errors leave delivery ambiguous.
                Effect.catchTags({
                  CodexAppServerRequestError: (error) =>
                    error.code === -32601 ? Effect.succeed(false) : Effect.fail(error),
                }),
              );
          },
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CODEX_PROVIDER,
                detail: "Failed to inject historical context",
                cause,
              }),
          ),
        ),
        startTurn: (turnInput) => {
          const goalCommand =
            turnInput.restartContinuationOfRunId === undefined
              ? parseGoalCommand(turnInput.message)
              : null;
          if (goalCommand !== null) return runGoalCommand(turnInput, goalCommand);
          return Effect.gen(function* () {
            yield* startNativeTurn(
              turnInput,
              turnInput.restartContinuationOfRunId === undefined
                ? yield* toCodexInput(turnInput)
                : [],
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CODEX_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          );
        },
        steerTurn: Effect.fn("CodexAdapterV2.steerTurn")(
          function* (turnInput) {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            const latestTurnId = latestRunTurnId(turnInput.providerTurnId);
            const held = heldGoalTurn(turnInput.providerThread, latestTurnId);
            const providerTurnId =
              held === undefined
                ? latestTurnId
                : ((yield* Deferred.await(held.hold.next))?.providerTurnId ?? latestTurnId);
            let activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
              (candidate) => candidate.providerTurnId === providerTurnId,
            );
            const startingRetry = capacityContinuations.get(threadId)?.context;
            if (activeTurn === undefined && startingRetry?.providerTurnId === providerTurnId) {
              activeTurn = startingRetry;
            }
            while (activeTurn?.capacityRetryPending !== undefined) {
              activeTurn = yield* Deferred.await(activeTurn.capacityRetryPending);
            }
            if (activeTurn === undefined) {
              return yield* toProtocolError(
                `Provider turn ${turnInput.providerTurnId} is not active and cannot be steered.`,
              );
            }

            const codexInput = yield* toCodexInput(turnInput);
            yield* client.request("turn/steer", {
              expectedTurnId: activeTurn.nativeTurnId,
              input: codexInput,
              threadId,
            });
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        // Dropping this connection's subscription lets the shared app-server
        // shut the native thread (and its MCP servers) down once it is idle.
        unloadThread: Effect.fn("CodexAdapterV2.unloadThread")(
          function* (unloadInput) {
            const nativeThreadId = yield* getNativeThreadId(unloadInput.providerThread);
            sessionApprovals.delete(nativeThreadId);
            yield* client.request("thread/unsubscribe", { threadId: nativeThreadId });
          },
          (effect, unloadInput) =>
            effect.pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterProtocolError"
                  ? cause
                  : new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: CODEX_PROVIDER,
                      detail: `Failed to unload Codex thread for provider thread ${unloadInput.providerThread.id}`,
                      cause,
                    }),
              ),
            ),
        ),
      };

  return { runtimeThreadControl };
});

export type RuntimeThreadControlPart = ReturnType<typeof installRuntimeThreadControl> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRuntimeThreadControl>;
