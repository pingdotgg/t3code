import {
  type EnvironmentId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { newMessageId } from "~/lib/utils";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { makeThreadErrorSetter } from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";

interface ComposerResumeInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly resumableRunId: RunId | null;
  readonly hasHeldQueuedRuns: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null;
  readonly composerRef: ComposerHandleRef;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: EnvironmentThreadShell["id"];
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
  readonly clearUsageLimitsFor: ReturnType<typeof useUsageLimitsPanel>["clearFor"];
  readonly scrollToEnd: ReturnType<typeof useTimelineFollow>["scrollToEnd"];
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Resumes an interrupted run ("Continue where you left off.") and/or releases the turns held
 * in its queue. Shares the per-route send lock with the composer's send paths.
 */
export function useComposerResume(input: ComposerResumeInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    resumableRunId,
    hasHeldQueuedRuns,
    isSendBusy,
    isConnecting,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    runtimeMode,
    interactionMode,
    localCheckoutBranchMismatch,
    composerRef,
    persistThreadSettingsForNextTurn,
    clearUsageLimitsFor,
    scrollToEnd,
    setThreadError,
  } = input;
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const resumeThreadQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const [resumingThreadKeys, setResumingThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isResuming = resumingThreadKeys.has(routeThreadKey);
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);

  const onResume = async () => {
    if (
      !activeThread ||
      (resumableRunId === null && !hasHeldQueuedRuns) ||
      isSendBusy ||
      isResuming ||
      isConnecting ||
      isRevertingCheckpoint ||
      threadDetailLoading ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }
    const threadId = activeThread.id;
    sendInFlightRef.current = true;
    setResumingThreadKeys((current) => new Set(current).add(routeThreadKey));
    setThreadError(threadId, null);
    // Commands settle into a result, so this always runs.
    const resume = async () => {
      if (resumableRunId === null) {
        return resumeThreadQueue({ environmentId, input: { threadId } });
      }
      const createdAt = new Date().toISOString();
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId,
        createdAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") return settingsResult;
      const modelSelection = composerRef.current?.getSendContext().selectedModelSelection;
      const turnResult = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          manualContinuationOfRunId: resumableRunId,
          ...(modelSelection ? { modelSelection } : {}),
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "Continue where you left off.",
            attachments: [],
          },
          runtimeMode,
          interactionMode,
          dispatchMode: "start",
        },
      });
      if (turnResult._tag === "Failure" || !hasHeldQueuedRuns) return turnResult;
      clearUsageLimitsFor(routeThreadKey);
      return resumeThreadQueue({ environmentId, input: { threadId } });
    };
    const result = await resume();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Could not resume thread.",
        );
      }
    } else {
      clearUsageLimitsFor(routeThreadKey);
      if (currentRouteThreadKeyRef.current === routeThreadKey) scrollToEnd();
    }
    sendInFlightRef.current = false;
    setResumingThreadKeys((current) => {
      const next = new Set(current);
      next.delete(routeThreadKey);
      return next;
    });
  };

  return { onResume, isResuming };
}
