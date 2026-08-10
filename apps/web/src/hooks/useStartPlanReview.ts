import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationProposedPlan,
  OrchestrationThread,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { buildPlanReviewPrompt, buildPlanReviewThreadTitle } from "~/planReview";

export interface StartPlanReviewInput {
  readonly environmentId: EnvironmentId;
  readonly sourceThread: OrchestrationThread;
  readonly plan: OrchestrationProposedPlan;
  readonly modelSelection: ModelSelection;
  readonly instructions: string;
}

export function useStartPlanReview() {
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [startingPlanId, setStartingPlanId] = useState<string | null>(null);

  const start = useCallback(
    async ({
      environmentId,
      sourceThread,
      plan,
      modelSelection,
      instructions,
    }: StartPlanReviewInput) => {
      const createdAt = new Date().toISOString();
      const reviewThreadId = newThreadId();
      const title = buildPlanReviewThreadTitle(plan.planMarkdown);
      setStartingPlanId(plan.id);

      const result = await startThreadTurn({
        environmentId,
        input: {
          threadId: reviewThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildPlanReviewPrompt({ planMarkdown: plan.planMarkdown, instructions }),
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: sourceThread.projectId,
              title,
              modelSelection,
              runtimeMode: sourceThread.runtimeMode,
              interactionMode: "default",
              branch: sourceThread.branch,
              worktreePath: sourceThread.worktreePath,
              createdAt,
            },
          },
          sourceProposedPlan: {
            threadId: sourceThread.id,
            planId: plan.id,
            kind: "review",
          },
          createdAt,
        },
      });

      setStartingPlanId(null);
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Plan review started",
          description: "The reviewer is working in the background.",
        });
        return reviewThreadId;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start plan review",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return null;
    },
    [startThreadTurn],
  );

  return { start, startingPlanId };
}
