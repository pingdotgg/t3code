/** The question fields answer handling reads. Web and mobile question types both fit it. */
export interface PendingUserInputQuestion {
  readonly id: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value?: string | undefined }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly supportsNote?: boolean | undefined;
  readonly initialAnswer?: string | undefined;
  readonly required?: boolean | undefined;
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

// With a picked option the typed text is a note on it; with none it is the answer itself.
function takesNote(question: PendingUserInputQuestion): boolean {
  return question.supportsNote === true && question.allowCustomAnswer !== false;
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
  if (takesNote(question)) {
    const selected = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
    if (selected.length > 0) return question.multiSelect ? selected : (selected[0] ?? null);
  }
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer !== null && customAnswer.length > 0) {
    return customAnswer;
  }
  if (question.required === false && question.options.length === 0) {
    return "";
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  const fallback =
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null);
  if (question.multiSelect) {
    // Checking nothing answers "none of these" unless the provider requires a choice.
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (fallback ?? (question.required ? null : []));
  }
  return selectedOptionValues[0] ?? fallback;
}

/** The note to send with the picked options, or null when the typed text is the answer. */
function resolvePendingUserInputNote(
  question: PendingUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  if (!takesNote(question)) return null;
  if (normalizeSelectedOptionValues(question, draft?.selectedOptionValues).length === 0) {
    return null;
  }
  return normalizeDraftAnswer(draft?.customAnswer);
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
    !takesNote(question) && (question.initialAnswer !== undefined || customAnswer.trim().length > 0)
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
  if (
    question.allowCustomAnswer !== false &&
    !takesNote(question) &&
    normalizeDraftAnswer(draft?.customAnswer)
  ) {
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
  const customAnswer = takesNote(question) ? (draft?.customAnswer ?? "") : "";

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer,
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  // With a note in play, tapping the pick again clears it so the text can be the answer.
  if (
    takesNote(question) &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  ) {
    return { customAnswer };
  }
  return {
    customAnswer,
    selectedOptionValues: [resolvedOptionValue],
  };
}

/**
 * The answers to submit keyed by question id, or null while a question still needs one.
 * An optional single choice left unselected is skipped: it gets no entry.
 */
export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswer> | null {
  const entries: Array<[string, PendingUserInputAnswer]> = [];

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer === null) {
      if (question.required === false && !draft?.attachmentsBlocked) continue;
      return null;
    }
    entries.push([question.id, answer]);
  }

  return Object.fromEntries(entries);
}

/** Notes keyed by question id, for questions answered with picked options and a note. */
export function buildPendingUserInputNotes(
  questions: ReadonlyArray<PendingUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> {
  return Object.fromEntries(
    questions.flatMap((question) => {
      const note = resolvePendingUserInputNote(question, draftAnswers[question.id]);
      return note === null ? [] : [[question.id, note] as const];
    }),
  );
}
