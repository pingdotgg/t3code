import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PlanId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { Dispatch, SetStateAction } from "react";
import { newMessageId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatMessage } from "../../types";
import { formatOutgoingPrompt, type makeThreadErrorSetter } from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { useTimelineFollow } from "./useTimelineFollow";

type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;

interface BuildProposedPlanInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly isServerThread: boolean;
  readonly isSendBusy: boolean;
  readonly composerRef: ComposerHandleRef;
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly runtimeMode: RuntimeMode;
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly anchorNewTurn: ReturnType<typeof useTimelineFollow>["anchorNewTurn"];
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: EnvironmentThreadShell["id"];
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Implements a proposed plan on this thread (Build). Resolves whether the turn started.
 */
export function useBuildProposedPlan(input: BuildProposedPlanInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    isServerThread,
    isSendBusy,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    runtimeMode,
    localCheckoutBranchMismatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
    persistThreadSettingsForNextTurn,
  } = input;
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);

  return async function buildProposedPlan(plan: {
    readonly id: PlanId;
    readonly planMarkdown: string;
  }) {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      sendInFlightRef.current
    ) {
      return false;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return false;
    }

    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: buildPlanImplementationPrompt(plan.planMarkdown),
    });

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);

    anchorNewTurn(
      scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageIdForSend,
    );

    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId: threadIdForSend,
      createdAt: messageCreatedAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode: "default",
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      settingsResult._tag === "Failure" ? settingsResult : null;

    if (failure === null) {
      setComposerDraftInteractionMode(
        scopeThreadRef(activeThread.environmentId, threadIdForSend),
        "default",
      );

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: sendCtx.selectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: plan.id,
          },
          createdAt: messageCreatedAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return true;
    }

    setOptimisticUserMessages((existing) =>
      existing.filter((message) => message.id !== messageIdForSend),
    );
    if (!isAtomCommandInterrupted(failure)) {
      const error = squashAtomCommandFailure(failure);
      setThreadError(
        threadIdForSend,
        error instanceof Error ? error.message : "Failed to start plan build.",
      );
    }
    sendInFlightRef.current = false;
    resetLocalDispatch();
    return false;
  };
}
