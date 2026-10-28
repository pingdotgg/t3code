import {
  CommandId,
  type EnvironmentId,
  type PipelineId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { randomUUID } from "~/lib/utils";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { makeThreadErrorSetter } from "../ChatView.logic";
import { draftPipelineSelectionAtom, draftSendState } from "./chatViewSend";
import { commandIdForPipelineSend, pipelineSendRetryKey } from "./composerSend.logic";
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
  const { sendInFlight: sendInFlightRef, pipelineCommands: pipelineCommandsRef } =
    draftSendState(routeThreadKey);

  return async ({
    threadId,
    pipelineId,
    projectId,
    text,
    promptAtSend,
    workspaceStrategy,
  }: {
    readonly threadId: ThreadId;
    readonly pipelineId: PipelineId;
    readonly projectId: ProjectId;
    readonly text: string;
    /** The draft's prompt when sent; a draft edited since is left alone. */
    readonly promptAtSend: string;
    readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  }) => {
    const retryKey = pipelineSendRetryKey({
      routeKey: routeThreadKey,
      pipelineId,
      projectId,
      workspaceStrategy,
      text,
    });
    const commandId = commandIdForPipelineSend(pipelineCommandsRef.current, retryKey, () =>
      CommandId.make(randomUUID()),
    );
    setThreadError(threadId, null);
    const result = await startPipelineRun({
      environmentId,
      input: {
        commandId,
        pipelineId,
        projectId,
        input: text,
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
    pipelineCommandsRef.current.delete(retryKey);
    const parentRef = scopeThreadRef(environmentId, result.value.run.parentThreadId);
    const stillOnDraft = currentRouteThreadKeyRef.current === routeThreadKey;
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    if (draft?.prompt === promptAtSend) {
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
