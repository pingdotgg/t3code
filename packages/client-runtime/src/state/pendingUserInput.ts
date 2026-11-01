/** The question fields answer handling reads. Web and mobile question types both fit it. */
export interface PendingUserInputQuestion {
  readonly id: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value?: string | undefined }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly initialAnswer?: string | undefined;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

export type PendingUserInputAnswer = string | ReadonlyArray<string>;

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Provider option values stay exact, including whitespace. Only options without a value match by label.
function resolvePendingUserInputOptionValue(
  question: PendingUserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

/** The draft's selections that name an offered option, deduplicated, in selection order. */
export function normalizeSelectedOptionValues(
  question: PendingUserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

/** The answer to submit for one question, or null while it is unanswered. */
export function resolvePendingUserInputAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswer | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer !== null && customAnswer.length > 0) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  if (question.multiSelect) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (customAnswer ??
          (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null));
  }
  return (
    selectedOptionValues[0] ??
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

export function setPendingUserInputCustomAnswer(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  const selectedOptionValues =
    question.initialAnswer !== undefined || customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (question.allowCustomAnswer !== false && normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

/** Toggles an offered option. An unknown option returns the same draft. */
export function togglePendingUserInputOptionSelection(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [resolvedOptionValue],
  };
}

export function canSkipPendingUserInputQuestion(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): boolean {
  return question.required === false && !draft?.attachmentsBlocked;
}

/** Answered questions keyed by id, or null while a required answer or attachment is pending. */
export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswer> | null {
  const answers: Record<string, PendingUserInputAnswer> = {};

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer === null) {
      if (canSkipPendingUserInputQuestion(question, draft)) continue;
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}
