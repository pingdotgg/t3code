import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { truncate } from "@t3tools/shared/String";
import { useNavigate } from "@tanstack/react-router";
import type { Dispatch, SetStateAction } from "react";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { buildMessageContext } from "../../lib/composerContextRecords";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../proposedPlan";
import type { LatestProposedPlanState } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatMessage } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  formatOutgoingPrompt,
  type makeThreadErrorSetter,
  waitForStartedServerThread,
} from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { useTimelineFollow } from "./useTimelineFollow";

type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;

interface PlanSendBase {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadBranch: string | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly isServerThread: boolean;
  readonly isSendBusy: boolean;
  readonly composerRef: ComposerHandleRef;
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
}

interface PlanFollowUpSendInput extends PlanSendBase {
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
 * Answers a proposed plan on this thread: refine it in plan mode, or implement it here
 * (which links the turn to the plan). Resolves whether the turn started.
 */
export function usePlanFollowUpSend(input: PlanFollowUpSendInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    activeProposedPlan,
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

  return async function submitPlanFollowUp({
    text,
    context,
    interactionMode: nextInteractionMode,
  }: {
    text: string;
    context?: ReturnType<typeof buildMessageContext>;
    interactionMode: "default" | "plan";
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

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
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
      text: trimmed,
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
        ...(context ? { context } : {}),
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
      interactionMode: nextInteractionMode,
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      settingsResult._tag === "Failure" ? settingsResult : null;

    if (failure === null) {
      setComposerDraftInteractionMode(
        scopeThreadRef(activeThread.environmentId, threadIdForSend),
        nextInteractionMode,
      );

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(context ? { context } : {}),
            attachments: [],
          },
          modelSelection: sendCtx.selectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
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
        error instanceof Error ? error.message : "Failed to send plan follow-up.",
      );
    }
    sendInFlightRef.current = false;
    resetLocalDispatch();
    return false;
  };
}

interface ImplementPlanInNewThreadInput extends PlanSendBase {
  readonly activeProject: EnvironmentProject | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly defaultRuntimeMode: RuntimeMode;
}

/**
 * Starts a fresh thread that implements the active proposed plan, then opens it. The new
 * thread is deleted again if it cannot be started or opened.
 */
export function useImplementPlanInNewThread(input: ImplementPlanInNewThreadInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    activeProject,
    activeEnvironmentUnavailable,
    defaultRuntimeMode,
  } = input;
  const navigate = useNavigate();
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);

  return async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: buildPlanImplementationPrompt(planMarkdown),
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = sendCtx.selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode: defaultRuntimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: nextThreadModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode: defaultRuntimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    sendInFlightRef.current = false;
    resetLocalDispatch();
  };
}
