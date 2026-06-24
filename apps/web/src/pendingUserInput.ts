import type { UserInputQuestion } from "@t3tools/contracts";

// ponytail: answerSource makes the active input source authoritative so a
// clicked preset cannot be overwritten by stale custom editor state at submit
// (the #918/#528 preset/custom race). Kept as a discriminator over upstream's
// existing selectedOptionLabels[] shape to preserve multiSelect.
export type PendingUserInputAnswerSource = "option" | "custom";

export interface PendingUserInputDraftAnswer {
  answerSource?: PendingUserInputAnswerSource;
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
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

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      normalized.push(trimmed);
    }
  }

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  if (draft?.answerSource === "custom") {
    return customAnswer;
  }
  if (draft?.answerSource === "option") {
    if (question.multiSelect) {
      return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
    }
    return selectedOptionLabels[0] ?? null;
  }

  // No explicit source — legacy fallback (custom takes precedence).
  if (customAnswer) {
    return customAnswer;
  }
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const normalizedCustomAnswer = normalizeDraftAnswer(customAnswer);
  // ponytail: collapse whitespace-only drafts to "" so we never persist pure-
  // whitespace custom text that resolves to no answer but clutters the store.
  const storedCustomAnswer = normalizedCustomAnswer ? customAnswer : "";
  const selectedOptionLabels = normalizedCustomAnswer
    ? undefined
    : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  const answerSource: PendingUserInputAnswerSource | undefined = normalizedCustomAnswer
    ? "custom"
    : selectedOptionLabels.length > 0
      ? "option"
      : undefined;

  return {
    ...(answerSource ? { answerSource } : {}),
    customAnswer: storedCustomAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      answerSource: nextSelectedOptionLabels.length > 0 ? "option" : undefined,
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    answerSource: "option",
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

export function setPendingUserInputSelectedOption(
  _draft: PendingUserInputDraftAnswer | undefined,
  selectedOptionLabel: string,
): PendingUserInputDraftAnswer {
  return {
    answerSource: "option",
    selectedOptionLabels: [selectedOptionLabel],
    customAnswer: "",
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
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
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
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
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
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
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
