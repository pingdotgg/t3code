import type { UserInputQuestion } from "@t3tools/contracts";

export type PendingUserInputAnswerSource = "option" | "custom";

export interface PendingUserInputDraftAnswer {
  answerSource?: PendingUserInputAnswerSource;
  selectedOptionLabel?: string;
  customAnswer?: string;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabel: string | undefined;
  customAnswer: string;
  resolvedAnswer: string | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionLabel = normalizeDraftAnswer(draft?.selectedOptionLabel);
  if (draft?.answerSource === "option") {
    return selectedOptionLabel;
  }
  if (draft?.answerSource === "custom") {
    return customAnswer;
  }
  if (customAnswer) {
    return customAnswer;
  }

  return selectedOptionLabel;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const normalizedCustomAnswer = normalizeDraftAnswer(customAnswer);
  const selectedOptionLabel = normalizedCustomAnswer ? undefined : draft?.selectedOptionLabel;
  const answerSource = normalizedCustomAnswer
    ? "custom"
    : selectedOptionLabel
      ? "option"
      : undefined;

  return {
    ...(answerSource ? { answerSource } : {}),
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
  };
}

export function setPendingUserInputSelectedOption(
  _draft: PendingUserInputDraftAnswer | undefined,
  selectedOptionLabel: string,
): PendingUserInputDraftAnswer {
  return {
    answerSource: "option",
    selectedOptionLabel,
    customAnswer: "",
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null {
  const answers: Record<string, string> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = resolvePendingUserInputAnswer(activeDraft);
  const customAnswer = activeDraft?.customAnswer ?? "";
  const normalizedCustomAnswer = normalizeDraftAnswer(customAnswer);
  const usingCustomAnswer =
    activeDraft?.answerSource === "custom"
      ? normalizedCustomAnswer !== null
      : activeDraft?.answerSource === "option"
        ? false
        : normalizedCustomAnswer !== null;
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabel: activeDraft?.selectedOptionLabel,
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
