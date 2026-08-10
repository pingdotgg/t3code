/**
 * Starts a PR review as a background thread.
 *
 * A review is just a thread: create it, start one turn with the review prompt,
 * and leave it running. Deliberately does not navigate — the point is that the
 * review happens in the background of the project while you keep working, so
 * it surfaces through the sidebar and the panel's status chip instead.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChangeRequest,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useCodeReviewStore } from "~/codeReviewStore";
import { newMessageId, newThreadId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { buildCodeReviewPrompt, buildCodeReviewThreadTitle } from "./reviewPrompt";

export interface StartCodeReviewScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /**
   * Resolved at click time rather than passed as a value: the only selection
   * guaranteed to name a real model is the one the composer would send with,
   * and a project or draft thread can carry an empty `model` string that the
   * thread.create schema rejects.
   */
  readonly resolveModelSelection: () => ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly branch: string | null;
  readonly instructions: string;
}

export function useStartCodeReview(scope: StartCodeReviewScope) {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const [startingNumber, setStartingNumber] = useState<number | null>(null);

  const start = useCallback(
    async (changeRequest: ChangeRequest) => {
      const { environmentId, projectId } = scope;
      if (environmentId === null || projectId === null) return;

      const modelSelection = scope.resolveModelSelection();
      if (modelSelection === null || modelSelection.model.trim().length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the review",
            description: "Choose a model in the composer before reviewing.",
          }),
        );
        return;
      }

      const createdAt = new Date().toISOString();
      const threadId = newThreadId();
      const title = buildCodeReviewThreadTitle(changeRequest);
      setStartingNumber(changeRequest.number);

      const createResult = await createThread({
        environmentId,
        input: {
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode: scope.runtimeMode,
          interactionMode: "default",
          branch: scope.branch,
          // Reviews run on the current checkout, not a per-PR worktree: the
          // agent fetches the diff, so materializing the branch would cost a
          // worktree per review for context it does not need.
          worktreePath: null,
          createdAt,
        },
      });

      if (createResult._tag === "Failure") {
        setStartingNumber(null);
        if (!isAtomCommandInterrupted(createResult)) {
          reportFailure("Could not start the review", createResult);
        }
        return;
      }

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildCodeReviewPrompt({ changeRequest, instructions: scope.instructions }),
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: scope.runtimeMode,
          interactionMode: "default",
          createdAt,
        },
      });

      setStartingNumber(null);

      if (startResult._tag === "Failure") {
        // Do not leave an empty thread in the sidebar for a review that never
        // ran; the same cleanup the plan-implementation flow does.
        const cleanup = await deleteThread({ environmentId, input: { threadId } });
        if (cleanup._tag === "Failure" && !isAtomCommandInterrupted(cleanup)) {
          console.warn("Failed to clean up review thread after start failure.", cleanup);
        }
        if (!isAtomCommandInterrupted(startResult)) {
          reportFailure("Could not start the review", startResult);
        }
        return;
      }

      useCodeReviewStore.getState().record(
        {
          environmentId,
          projectId,
          provider: changeRequest.provider,
          number: changeRequest.number,
        },
        { threadId, startedAt: createdAt },
      );
    },
    [createThread, deleteThread, scope, startThreadTurn],
  );

  return { start, startingNumber };
}

function reportFailure(title: string, failure: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(failure);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
