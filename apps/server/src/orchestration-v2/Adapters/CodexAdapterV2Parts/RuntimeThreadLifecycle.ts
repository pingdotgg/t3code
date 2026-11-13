import { pipe } from "effect/Function";
import { revertCodexThread } from "../../../provider/CodexThreadRevert.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, codexTimestamp, isProviderAdapterRuntimeRequestResponseError, toProtocolError } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { getNativeThreadId, providerThreadFromCodexThread, readCodexThreadHistoryMetadata, resolveCodexForkBoundary, resolveCodexRollbackTurnCount } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { codexThreadRuntimeParams } from "../CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";
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
import type { RuntimeThreadControlPart } from "./RuntimeThreadControl.ts";
import type { RuntimeInterruptPart } from "./RuntimeInterrupt.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart & MakeRootTerminalEventPart & FinalizeCodexTurnPart & RetryCapacityFailurePart & RuntimeThreadControlPart & RuntimeInterruptPart;

export const installRuntimeThreadLifecycle = Effect.fnUntraced(function* (deps: Deps) {
  const { adapterOptions, client, ensureInitialized, idAllocator, input, mcpApps, mcpSessions, pendingRuntimeRequests, readMcpSession, resumeNativeThread, runtimeInterrupt, runtimeThreadControl, turnTokenUsageByThread } = deps;

const runtimeThreadLifecycle: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "respondToRuntimeRequest" | "uploadFeedback" | "mcpApps" | "readThreadSnapshot" | "rollbackThread" | "forkThread"> = {
        respondToRuntimeRequest: Effect.fn("CodexAdapterV2.respondToRuntimeRequest")(
          function* (requestInput) {
            const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
              String(requestInput.requestId),
            );
            if (pending === undefined) {
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CODEX_PROVIDER,
                requestId: requestInput.requestId,
                cause: toProtocolError(
                  `No pending Codex runtime request ${requestInput.requestId}.`,
                ),
              });
            }
            if (pending.type === "user_input") {
              if (requestInput.answers === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: CODEX_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: toProtocolError(
                    `Codex user input request ${requestInput.requestId} requires answers.`,
                  ),
                });
              }
              yield* Deferred.succeed(pending.answers, requestInput.answers);
              return;
            }
            if (requestInput.decision === undefined) {
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CODEX_PROVIDER,
                requestId: requestInput.requestId,
                cause: toProtocolError(
                  `Codex ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                ),
              });
            }
            yield* Deferred.succeed(pending.decision, requestInput.decision);
          },
          (effect, requestInput) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRuntimeRequestResponseError(cause)
                  ? cause
                  : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver: CODEX_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
              ),
            ),
        ),
        uploadFeedback: Effect.fn("CodexAdapterV2.uploadFeedback")(
          function* (feedbackInput) {
            const threadId = yield* getNativeThreadId(feedbackInput.providerThread);
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(
                client.request("feedback/upload", {
                  classification: "bug",
                  includeLogs: true,
                  ...(feedbackInput.reason ? { reason: feedbackInput.reason } : {}),
                  threadId,
                }),
              ),
            );
            return { feedbackId: response.threadId };
          },
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CODEX_PROVIDER,
                detail: "Failed to upload Codex thread feedback.",
                payload: cause,
              }),
          ),
        ),
        mcpApps,
        readThreadSnapshot: Effect.fn("CodexAdapterV2.readThreadSnapshot")(
          function* (threadInput) {
            const threadId = yield* getNativeThreadId(threadInput.providerThread);
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(client.request("thread/read", { threadId, includeTurns: true })),
            );
            return {
              providerThread: {
                ...threadInput.providerThread,
                nativeThreadRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: response.thread.id,
                  strength: "strong" as const,
                },
                nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
                updatedAt: codexTimestamp(response.thread.updatedAt),
              },
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
              providerPayload: response.thread,
            };
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("CodexAdapterV2.rollbackThread")(
          function* (threadInput) {
            const threadId = yield* getNativeThreadId(threadInput.providerThread);
            const numTurns = yield* resolveCodexRollbackTurnCount(threadInput);
            const nativeConversationHeadRef =
              threadInput.target.type === "provider_turn"
                ? threadInput.target.providerTurn.nativeTurnRef
                : null;
            if (numTurns === 0) {
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  nativeConversationHeadRef,
                  status: "idle" as const,
                },
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              };
            }
            const { historyMode, loaded } = yield* ensureInitialized.pipe(
              Effect.andThen(readCodexThreadHistoryMetadata(client.raw, threadId)),
            );
            if (historyMode !== "paginated") {
              return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: CODEX_PROVIDER,
                providerThreadId: threadInput.providerThread.id,
                cause: `Cannot roll back Codex thread ${threadId}: the thread uses legacy history, which Codex 0.156 cannot revert.`,
              });
            }
            // thread/revert requires the thread loaded in this app-server; resume after restart or idle release.
            if (!loaded) {
              yield* resumeNativeThread(threadId, {
                excludeTurns: true,
                ...codexThreadRuntimeParams({
                  threadId: threadInput.providerThread.appThreadId,
                  mcpSession: yield* readMcpSession(threadInput.providerThread.appThreadId),
                  modelSelection: input.modelSelection,
                  runtimePolicy: input.runtimePolicy,
                }),
              });
            }
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(revertCodexThread(client, threadId, numTurns)),
            );
            turnTokenUsageByThread.delete(threadId);
            return {
              providerThread: {
                ...threadInput.providerThread,
                nativeThreadRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: response.thread.id,
                  strength: "strong" as const,
                },
                nativeConversationHeadRef,
                status: "idle" as const,
                updatedAt: codexTimestamp(response.thread.updatedAt),
              },
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
              providerPayload: response.thread,
            };
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("CodexAdapterV2.forkThread")(
          function* (threadInput) {
            const threadId = yield* getNativeThreadId(threadInput.sourceProviderThread);
            const boundary = yield* resolveCodexForkBoundary(threadInput);
            const fork = client.request("thread/fork", {
              threadId,
              ...(boundary.lastTurnId === undefined ? {} : { lastTurnId: boundary.lastTurnId }),
              ...codexThreadRuntimeParams({
                threadId: threadInput.targetThreadId,
                mcpSession: yield* mcpSessions.read(threadInput.targetThreadId),
                ...(threadInput.modelSelection === undefined
                  ? {}
                  : { modelSelection: threadInput.modelSelection }),
                ...(threadInput.runtimePolicy === undefined
                  ? {}
                  : { runtimePolicy: threadInput.runtimePolicy }),
              }),
            });
            const response = yield* ensureInitialized.pipe(
              Effect.andThen(
                fork.pipe(
                  Effect.catchTags({
                    CodexAppServerRequestError: (cause) =>
                      /\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(cause.errorMessage)
                        ? client.raw
                            .request("thread/unarchive", { threadId })
                            .pipe(Effect.andThen(fork))
                        : Effect.fail(cause),
                  }),
                ),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            );
            let forkedThread = response.thread;
            if (boundary.rollbackTurnCount > 0) {
              const { historyMode } = yield* ensureInitialized.pipe(
                Effect.andThen(readCodexThreadHistoryMetadata(client.raw, response.thread.id)),
              );
              if (historyMode !== "paginated") {
                return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: CODEX_PROVIDER,
                  providerThreadId: threadInput.sourceProviderThread.id,
                  cause: `Cannot fork Codex thread ${threadId} at provider turn ${threadInput.providerTurnId}: the source turn has no native Codex turn reference, and the forked thread uses legacy history which Codex 0.156 cannot revert.`,
                });
              }
              forkedThread = (yield* ensureInitialized.pipe(
                Effect.andThen(
                  revertCodexThread(client, response.thread.id, boundary.rollbackTurnCount),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: CODEX_PROVIDER,
                      providerThreadId: threadInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              )).thread;
            }
            return providerThreadFromCodexThread({
              appThreadId: threadInput.targetThreadId,
              idAllocator,
              ownerNodeId: threadInput.ownerNodeId ?? null,
              providerSessionId: input.providerSessionId,
              providerInstanceId: adapterOptions.instanceId,
              thread: forkedThread,
              forkedFrom: {
                providerThreadId: threadInput.sourceProviderThread.id,
                ...(threadInput.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: threadInput.providerTurnId }),
              },
            });
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };

const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        ...runtimeThreadControl,
        ...runtimeInterrupt,
        ...runtimeThreadLifecycle,
      };

  return { runtimeThreadLifecycle, runtime };
});

export type RuntimeThreadLifecyclePart = ReturnType<typeof installRuntimeThreadLifecycle> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRuntimeThreadLifecycle>;
