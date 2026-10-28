import type { EnvironmentId, PipelineId, ThreadContextRecord } from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

/** The pipeline chosen on a draft, remembered with the environment it was chosen from. */
export interface DraftPipelineSelection {
  readonly environmentId: EnvironmentId;
  readonly pipelineId: PipelineId;
}

/**
 * The selected pipeline for a draft in `environmentId`, or null. Pipelines live on one server, so
 * a selection made before the draft moved to another environment no longer applies.
 */
export function activeDraftPipelineId(
  selection: DraftPipelineSelection | null,
  environmentId: EnvironmentId,
): PipelineId | null {
  return selection !== null && selection.environmentId === environmentId
    ? selection.pipelineId
    : null;
}

export const PIPELINE_TEXT_ONLY_HINT =
  "Pipelines take text only. Remove attachments and added context, or choose No pipeline.";

/** Why a pipeline cannot start from this draft: it carries more than text. */
export function pipelineSendBlock(input: {
  readonly attachmentCount: number;
  readonly hasContext: boolean;
}): string | null {
  return input.attachmentCount > 0 || input.hasContext ? PIPELINE_TEXT_ONLY_HINT : null;
}
