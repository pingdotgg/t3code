import {
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { newMessageId } from "~/lib/utils";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import type { buildMessageContext } from "../../lib/composerContextRecords";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  boundAttachmentIds,
  type ComposerSendSnapshot,
  type makeThreadErrorSetter,
  withMessageContext,
} from "../ChatView.logic";
import {
  draftFanoutSelectionsAtom,
  draftSendState,
  type MultipleModelTarget,
  type prepareTurnAttachments,
  restoreComposerDraft,
  startFanoutThread,
} from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";

interface MultipleModelSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: ComposerHandleRef;
  readonly promptRef: { current: string };
  readonly runtimeMode: RuntimeMode;
  readonly startFromOrigin: boolean;
  readonly resetLocalDispatch: ReturnType<typeof useLocalDispatchState>["resetLocalDispatch"];
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Starts one background thread per selected model, each in its own worktree. Failed models
 * stay selected and the prompt comes back, either straight into this composer or, when the
 * user has moved on, through a "Restore prompt" toast.
 */
export function useMultipleModelSend(input: MultipleModelSendInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    composerDraftTarget,
    composerRef,
    promptRef,
    runtimeMode,
    startFromOrigin,
    resetLocalDispatch,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const { sendInFlight: sendInFlightRef, uncertainSubmissions: uncertainSubmissionsRef } =
    draftSendState(routeThreadKey);

  return async ({
    threadId,
    project,
    branch,
    selections,
    targets,
    sendSnapshot,
    createdAt,
    attachmentsPromise,
    usesAttachmentUploads,
    readFileBlockReason,
    buildOutgoingMessageContext,
    isCurrentSend,
  }: {
    readonly threadId: ThreadId;
    readonly project: EnvironmentProject;
    readonly branch: string;
    readonly selections: ReadonlyArray<ModelSelection>;
    readonly targets: ReadonlyArray<MultipleModelTarget>;
    readonly sendSnapshot: ComposerSendSnapshot;
    readonly createdAt: string;
    readonly attachmentsPromise: ReturnType<typeof prepareTurnAttachments>;
    readonly usesAttachmentUploads: boolean;
    readonly readFileBlockReason: () => string | null;
    readonly buildOutgoingMessageContext: (
      attachmentIds: ReadonlyArray<string>,
    ) => ReturnType<typeof buildMessageContext>;
    /** False once a newer send from this composer started. */
    readonly isCurrentSend: () => boolean;
  }) => {
    const { attachments: attachmentsSnapshot, messageText } = sendSnapshot;
    const failedSelections: ModelSelection[] = [];
    let clearedDraft = false;
    let releasedComposer = false;
    let canRestoreDraft = () => false;
    let startedCount = 0;
    // Anything thrown here (an attachment the server can no longer take)
    // fails every selection; the draft restore below still runs.
    const sendResult = await settlePromise(async () => {
      const attachments = await attachmentsPromise;
      const fileBlockReason = readFileBlockReason();
      if (fileBlockReason !== null) throw new Error(fileBlockReason);
      const context = buildOutgoingMessageContext(
        boundAttachmentIds(attachments, attachmentsSnapshot),
      );
      const title = deriveThreadTitleSeed({
        text: messageText,
        attachments: attachmentsSnapshot,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      clearedDraft = true;
      const clearedDraftSnapshot = useComposerDraftStore
        .getState()
        .getComposerDraft(composerDraftTarget);
      const submittedSelections = appAtomRegistry.get(fanoutSelectionsAtom);
      canRestoreDraft = () =>
        currentRouteThreadKeyRef.current === routeThreadKey &&
        isCurrentSend() &&
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
          clearedDraftSnapshot &&
        appAtomRegistry.get(fanoutSelectionsAtom) === submittedSelections;
      setThreadError(threadId, null);
      const starts = Promise.all(
        targets.map(async (target) => {
          const started = await startFanoutThread({
            retryKey: JSON.stringify([
              routeThreadKey,
              target.selection.instanceId,
              target.selection.model,
            ]),
            model: target.selection.model,
            uncertainSubmissions: uncertainSubmissionsRef.current,
            start: (targetThreadId) => {
              const supportsInlineMessageContext =
                appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
                  .capabilities.inlineMessageContext === true;
              return startThreadTurn({
                environmentId,
                input: {
                  threadId: targetThreadId,
                  message: {
                    messageId: newMessageId(),
                    role: "user",
                    attachments,
                    ...withMessageContext({
                      text: target.text,
                      context,
                      supportsInlineMessageContext,
                    }),
                  },
                  modelSelection: target.selection,
                  titleSeed: title,
                  runtimeMode,
                  interactionMode: target.interactionMode,
                  bootstrap: {
                    createThread: {
                      projectId: project.id,
                      title,
                      modelSelection: target.selection,
                      runtimeMode,
                      interactionMode: target.interactionMode,
                      branch,
                      worktreePath: null,
                      createdAt: createdAt,
                    },
                    prepareWorktree: {
                      projectCwd: project.workspaceRoot,
                      baseBranch: branch,
                      requireWorktree: true,
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  },
                  createdAt: createdAt,
                },
              });
            },
            openThread: (threadId) =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
              }),
          });
          if (started) startedCount += 1;
          else failedSelections.push(target.selection);
        }),
      );
      sendInFlightRef.current = false;
      resetLocalDispatch();
      releasedComposer = true;
      await starts;
      if (startedCount > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"} in background`,
          }),
        );
      }
      if (failedSelections.length === 0 && usesAttachmentUploads) {
        releaseDraftAttachments(attachmentsSnapshot);
      }
    });
    if (sendResult._tag === "Failure") {
      const error = squashAtomCommandFailure(sendResult);
      failedSelections.push(...selections);
      setThreadError(threadId, error instanceof Error ? error.message : "Failed to send messages.");
    }
    const restoreFailedDraft = () => {
      appAtomRegistry.set(fanoutSelectionsAtom, failedSelections);
      if (clearedDraft) {
        restoreComposerDraft(composerDraftTarget, sendSnapshot);
        if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = messageText;
          composerRef.current.resetCursorState({
            cursor: collapseExpandedComposerCursor(messageText, messageText.length),
            prompt: messageText,
            detectTrigger: true,
          });
        }
      }
    };
    if (failedSelections.length > 0) {
      if (canRestoreDraft() && composerRef.current) {
        restoreFailedDraft();
      } else if (clearedDraft) {
        const recoveryToastId = toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "A background prompt could not be sent",
            description:
              "Your newer draft is unchanged. Restore the failed prompt when this composer is empty.",
            timeout: 0,
            actionProps: {
              children: "Restore prompt",
              onClick: () => {
                if (
                  !draftId ||
                  !useComposerDraftStore.getState().getDraftSession(draftId) ||
                  sendInFlightRef.current ||
                  composerDraftHasUserContent(
                    useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
                  )
                ) {
                  toastManager.update(recoveryToastId, {
                    description:
                      "Return to the original draft and send or clear its current prompt before restoring.",
                  });
                  return;
                }
                restoreFailedDraft();
                void navigate({ to: "/draft/$draftId", params: { draftId } });
                toastManager.close(recoveryToastId);
              },
            },
          }),
        );
      }
    }
    if (!releasedComposer) {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    }
  };
}
