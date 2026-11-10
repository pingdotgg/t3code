import {
  type ChatAttachment,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type PipelineId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { nextPipelineStartAttempt } from "@t3tools/client-runtime/pipeline-start";
import type { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { randomUUID } from "~/lib/utils";
import {
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { makeThreadErrorSetter } from "../ChatView.logic";
import { draftPipelineSelectionAtom, draftSendState } from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";

interface PipelineSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: ComposerHandleRef;
  readonly promptRef: { current: string };
  readonly resetLocalDispatch: ReturnType<typeof useLocalDispatchState>["resetLocalDispatch"];
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/** What the user wrote and attached, by id; a draft whose key changed since send was edited. */
export function pipelineDraftContentKey(draft: ComposerThreadDraftState | null): string {
  if (draft === null) return "";
  const ids = (items: ReadonlyArray<{ readonly id: string }>) => items.map((item) => item.id);
  return JSON.stringify([
    draft.prompt,
    ids(draft.images),
    ids(draft.files),
    ids(draft.terminalContexts),
    ids(draft.previewAnnotations),
    ids(draft.reviewComments),
    draft.threadContexts.map((record) => record.contextId),
    draft.environmentContexts.map((record) => record.contextId),
  ]);
}

/**
 * Starts a pipeline run from a new-thread draft. Success clears the draft and opens the run's
 * parent thread; failure keeps the draft and toasts. A retry reuses its command id.
 */
export function usePipelineSend(input: PipelineSendInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    composerDraftTarget,
    composerRef,
    promptRef,
    resetLocalDispatch,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const startPipelineRun = useOrchestrationCommand(serverEnvironment.startPipelineRun, {
    reportFailure: false,
  });
  const { sendInFlight: sendInFlightRef, pipelineStart: pipelineStartRef } =
    draftSendState(routeThreadKey);

  return async ({
    threadId,
    pipelineId,
    projectId,
    text,
    draftAtSend,
    attachments,
    context,
    workspaceStrategy,
  }: {
    readonly threadId: ThreadId;
    readonly pipelineId: PipelineId;
    readonly projectId: ProjectId;
    readonly text: string;
    /** `pipelineDraftContentKey` of the draft when sent; a draft edited since is left alone. */
    readonly draftAtSend: string;
    /** Uploaded attachments, as a chat message would send them. */
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly context: OrchestrationMessageContext | undefined;
    readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  }) => {
    const attempt = (pipelineStartRef.current = nextPipelineStartAttempt(
      pipelineStartRef.current,
      { pipelineId, projectId, input: text, workspace: workspaceStrategy, attachments, context },
      randomUUID,
    ));
    setThreadError(threadId, null);
    const result = await startPipelineRun({
      environmentId,
      input: {
        commandId: attempt.commandId,
        pipelineId,
        projectId,
        input: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(context === undefined ? {} : { context }),
        workspaceStrategy,
        creationSource: "web",
      },
    });
    sendInFlightRef.current = false;
    resetLocalDispatch();
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Failed to start the pipeline.";
      setThreadError(threadId, message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start pipeline",
          description: message,
        }),
      );
      return;
    }
    pipelineStartRef.current = null;
    const parentRef = scopeThreadRef(environmentId, result.value.run.parentThreadId);
    const stillOnDraft = currentRouteThreadKeyRef.current === routeThreadKey;
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    if (pipelineDraftContentKey(draft) === draftAtSend) {
      useComposerDraftStore.getState().clearComposerContent(composerDraftTarget);
      if (stillOnDraft) {
        promptRef.current = "";
        composerRef.current?.resetCursorState();
      }
    }
    appAtomRegistry.set(draftPipelineSelectionAtom(routeThreadKey), null);
    if (stillOnDraft) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(parentRef) });
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Pipeline started",
          actionProps: {
            children: "Open",
            onClick: () => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(parentRef),
              });
            },
          },
        }),
      );
    }
  };
}
