import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  ProviderThreadId,
} from "@t3tools/contracts";
import { ProviderThreadId as ProviderThreadIdSchema } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";
import { DateTime, Effect, Layer, Stream } from "effect";

import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterProtocolError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Shape,
} from "../Services/ProviderAdapter.ts";

const CODEX_PROVIDER = "codex" as const;

export const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function providerThreadId(nativeThreadId: string): ProviderThreadId {
  return ProviderThreadIdSchema.make(`codex:${nativeThreadId}`);
}

function toProtocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    provider: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function normalizeCodexCause(error: CodexError.CodexAppServerError): unknown {
  return error;
}

function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.fromDateUnsafe(new Date(seconds * 1000));
}

export const CodexAdapterV2LiveLayer: Layer.Layer<
  ProviderAdapterV2,
  never,
  CodexClient.CodexAppServerClient
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;

    const adapter: ProviderAdapterV2Shape = {
      provider: CODEX_PROVIDER,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      ensureThread: (input) =>
        client.request("thread/start", {}).pipe(
          Effect.map((response): OrchestrationV2ProviderThread => {
            const nativeThreadId = response.thread.id;
            return {
              id: providerThreadId(nativeThreadId),
              provider: CODEX_PROVIDER,
              providerSessionId: input.providerSessionId ?? null,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                provider: CODEX_PROVIDER,
                nativeId: nativeThreadId,
                strength: "strong",
              },
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: codexTimestamp(response.thread.createdAt),
              updatedAt: codexTimestamp(response.thread.updatedAt),
            };
          }),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterEnsureThreadError({
                provider: CODEX_PROVIDER,
                threadId: input.threadId,
                cause: normalizeCodexCause(cause),
              }),
          ),
        ),
      resumeThread: (input) =>
        Effect.fail(
          new ProviderAdapterResumeThreadError({
            provider: CODEX_PROVIDER,
            providerSessionId: input.providerSessionId,
            providerThreadId: input.providerThreadId,
            cause: toProtocolError("Codex resumeThread adapter mapping is not implemented yet"),
          }),
        ),
      startTurn: (input) =>
        Stream.fail(
          new ProviderAdapterTurnStartError({
            provider: CODEX_PROVIDER,
            threadId: input.threadId,
            providerThreadId: input.providerThread.id,
            runId: input.runId,
            cause: toProtocolError("Codex startTurn adapter mapping is not implemented yet"),
          }),
        ),
      steerTurn: (input) =>
        Stream.fail(
          new ProviderAdapterSteerRunUnsupportedError({
            provider: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
          }),
        ),
      interruptTurn: (input) =>
        Effect.fail(
          new ProviderAdapterInterruptError({
            provider: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            providerTurnId: input.providerTurnId,
            cause: toProtocolError("Codex interruptTurn adapter mapping is not implemented yet"),
          }),
        ),
      respondToRuntimeRequest: (input) =>
        Effect.fail(
          new ProviderAdapterRuntimeRequestResponseError({
            provider: CODEX_PROVIDER,
            requestId: input.requestId,
            cause: toProtocolError(
              "Codex runtime request response adapter mapping is not implemented yet",
            ),
          }),
        ),
    };

    return ProviderAdapterV2.of(adapter);
  }),
);
