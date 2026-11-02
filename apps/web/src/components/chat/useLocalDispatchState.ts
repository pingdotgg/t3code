import { type MessageId, type RuntimeRequestId } from "@t3tools/contracts";
import { useState } from "react";
import { type ComposerSubmissionIntent } from "../../composer-logic";
import { type SessionPhase, type Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

export function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestRun: Thread["latestRun"] | null;
  latestUserMessageId: MessageId | null;
  phase: SessionPhase;
  activePendingApproval: RuntimeRequestId | null;
  activePendingUserInput: RuntimeRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const resetLocalDispatch = () => {
    setLocalDispatch(null);
  };

  const serverAcknowledgedLocalDispatch = hasServerAcknowledgedLocalDispatch({
    localDispatch,
    phase: input.phase,
    latestRun: input.activeLatestRun,
    latestUserMessageId: input.latestUserMessageId,
    runtime: input.activeThread?.runtime ?? null,
    hasPendingApproval: input.activePendingApproval !== null,
    hasPendingUserInput: input.activePendingUserInput !== null,
    threadError: input.threadError,
  });
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = (options?: {
    preparingWorktree?: boolean;
    submissionIntent?: ComposerSubmissionIntent;
  }) => {
    const preparingWorktree = Boolean(options?.preparingWorktree);
    setLocalDispatch((current) => {
      const active = serverAcknowledgedLocalDispatch ? null : current;
      if (active) {
        const submissionIntent = options?.submissionIntent ?? active.submissionIntent;
        return active.preparingWorktree === preparingWorktree &&
          active.submissionIntent === submissionIntent
          ? active
          : { ...active, preparingWorktree, submissionIntent };
      }
      return createLocalDispatchSnapshot(input.activeThread, {
        ...options,
        latestUserMessageId: input.latestUserMessageId,
      });
    });
  };

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: activeLocalDispatch?.submissionIntent === "background",
  };
}
