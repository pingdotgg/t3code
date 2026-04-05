import type { UserInputQuestion } from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";
import { resolvePendingUserInputAnswer } from "./pendingUserInput.shared";

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}
