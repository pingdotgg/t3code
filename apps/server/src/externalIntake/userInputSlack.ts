import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";

export interface PendingExternalUserInput {
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly createdAt: string;
}

function activityOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseQuestions(payload: Record<string, unknown>): ReadonlyArray<UserInputQuestion> | null {
  if (!Array.isArray(payload.questions)) {
    return null;
  }

  const questions = payload.questions.filter((entry): entry is UserInputQuestion => {
    if (!isRecord(entry)) return false;
    return (
      typeof entry.id === "string" &&
      entry.id.trim().length > 0 &&
      typeof entry.header === "string" &&
      typeof entry.question === "string" &&
      Array.isArray(entry.options)
    );
  });

  return questions.length > 0 ? questions : null;
}

function activityRequestId(activity: OrchestrationThreadActivity): ApprovalRequestId | null {
  const payload = isRecord(activity.payload) ? activity.payload : null;
  const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  return requestId.length > 0 ? ApprovalRequestId.make(requestId) : null;
}

export function derivePendingExternalUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingExternalUserInput> {
  const openByRequestId = new Map<string, PendingExternalUserInput>();

  for (const activity of [...activities].sort(activityOrder)) {
    const requestId = activityRequestId(activity);
    if (requestId === null) {
      continue;
    }

    if (activity.kind === "user-input.requested") {
      const payload = isRecord(activity.payload) ? activity.payload : null;
      const questions = payload === null ? null : parseQuestions(payload);
      if (questions !== null) {
        openByRequestId.set(String(requestId), {
          requestId,
          questions,
          createdAt: activity.createdAt,
        });
      }
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openByRequestId.delete(String(requestId));
      continue;
    }

    if (activity.kind === "provider.user-input.respond.failed") {
      const payload = isRecord(activity.payload) ? activity.payload : null;
      const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
      if (
        detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request")
      ) {
        openByRequestId.delete(String(requestId));
      }
    }
  }

  return [...openByRequestId.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function normalizeAnswerText(text: string): string | null {
  const normalized = text
    .replace(/<@[^>]+>/g, "")
    .replace(/\r/g, "\n")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function optionLabelForAnswer(question: UserInputQuestion, rawAnswer: string): string | null {
  const answer = rawAnswer.trim();
  if (answer.length === 0) {
    return null;
  }

  const numeric = /^(?:#)?(\d+)[.)]?$/.exec(answer);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    const option = question.options[index];
    return option?.label ?? null;
  }

  const normalized = answer.toLowerCase();
  return (
    question.options.find((option) => option.label.toLowerCase() === normalized)?.label ?? null
  );
}

function resolveQuestionAnswer(question: UserInputQuestion, rawAnswer: string): string | string[] {
  if (question.options.length === 0) {
    return rawAnswer.trim();
  }

  if (question.multiSelect) {
    const labels = rawAnswer
      .split(/[,;\n]+/)
      .map((part) => optionLabelForAnswer(question, part))
      .filter((label): label is string => label !== null);
    return labels.length > 0 ? Array.from(new Set(labels)) : rawAnswer.trim();
  }

  return optionLabelForAnswer(question, rawAnswer) ?? rawAnswer.trim();
}

function parseNumberedAnswers(text: string): Map<number, string> {
  const answers = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)[.)\]:-]?\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const answer = normalizeAnswerText(match[2] ?? "");
    if (answer !== null) {
      answers.set(index, answer);
    }
  }
  return answers;
}

function parseLabeledAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  text: string,
): Map<number, string> {
  const answers = new Map<number, string>();
  const questionKeys = questions.map((question) =>
    [question.id, question.header, question.question]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );

  for (const line of text.split("\n")) {
    const match = /^\s*([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").trim().toLowerCase();
    const answer = normalizeAnswerText(match[2] ?? "");
    if (answer === null) continue;
    const index = questionKeys.findIndex((keys) => keys.includes(key));
    if (index >= 0) {
      answers.set(index, answer);
    }
  }

  return answers;
}

export function buildSlackUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  text: string,
): ProviderUserInputAnswers | null {
  const normalized = normalizeAnswerText(text);
  if (normalized === null || questions.length === 0) {
    return null;
  }

  if (questions.length === 1) {
    const question = questions[0];
    if (question === undefined) {
      return null;
    }
    return {
      [question.id]: resolveQuestionAnswer(question, normalized),
    };
  }

  const numbered = parseNumberedAnswers(normalized);
  const labeled = parseLabeledAnswers(questions, normalized);
  const answers: Record<string, unknown> = {};

  questions.forEach((question, index) => {
    const rawAnswer = numbered.get(index) ?? labeled.get(index);
    if (rawAnswer !== undefined) {
      answers[question.id] = resolveQuestionAnswer(question, rawAnswer);
    }
  });

  return Object.keys(answers).length === questions.length
    ? (answers as ProviderUserInputAnswers)
    : null;
}
