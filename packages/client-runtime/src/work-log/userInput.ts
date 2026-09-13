import { projectQuestionToolInput } from "@t3tools/shared/toolActivity";
import {
  type OrchestrationThreadActivity,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isQuestionAnswer = Schema.is(UserInputAttachmentAnswerPayload);

function displayOptionAnswer(value: unknown, labels: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return labels.get(value) ?? value;
  if (Array.isArray(value)) return value.map((answer) => displayOptionAnswer(answer, labels));
  const nested = record(value);
  return nested && "answers" in nested
    ? { ...nested, answers: displayOptionAnswer(nested.answers, labels) }
    : value;
}

function questionFingerprint(
  turnId: string,
  questions: ReadonlyArray<unknown>,
): string | undefined {
  const texts = questions.map((question) => (typeof question === "string" ? question.trim() : ""));
  // Sort the fresh array in place because Hermes does not provide toSorted.
  return texts.length > 0 && texts.every(Boolean)
    ? JSON.stringify([turnId, texts.sort()])
    : undefined;
}

function withoutDuplicateQuestionTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const questions = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.answer-submitted" || !activity.turnId) continue;
    const payload = record(activity.payload);
    const texts = Object.values(record(payload?.questionTextById) ?? {});
    const fingerprint = questionFingerprint(activity.turnId, texts);
    if (fingerprint) questions.add(fingerprint);
  }
  if (questions.size === 0) return activities;
  const duplicateToolIds = new Set<string>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("tool.") || !activity.turnId) continue;
    const payload = record(activity.payload);
    if (typeof payload?.toolCallId !== "string") continue;
    const input = projectQuestionToolInput(record(payload.data) ?? {}, payload.title).input;
    if (!input) continue;
    const fingerprint = questionFingerprint(
      activity.turnId,
      input.questions.map((question) => record(question)?.question),
    );
    if (fingerprint && questions.has(fingerprint)) {
      duplicateToolIds.add(JSON.stringify([activity.turnId, payload.toolCallId]));
    }
  }
  return activities.filter((activity) => {
    const payload = record(activity.payload);
    const toolCallId = payload?.toolCallId;
    return (
      activity.tone === "error" ||
      /^(failed|declined|stopped|cancelled)$/.test(String(payload?.status)) ||
      !activity.kind.startsWith("tool.") ||
      typeof toolCallId !== "string" ||
      !duplicateToolIds.has(JSON.stringify([activity.turnId, toolCallId]))
    );
  });
}

/** Keep a question and its answer at the original tool position in the work log. */
export function foldUserInputActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const requests = new Map<string, OrchestrationThreadActivity[]>();
  for (const activity of activities) {
    if (
      activity.kind !== "user-input.requested" &&
      activity.kind !== "user-input.resolved" &&
      activity.kind !== "user-input.answer-submitted"
    )
      continue;
    const requestId = record(activity.payload)?.requestId;
    if (typeof requestId !== "string" || !requestId) continue;
    const group = requests.get(requestId) ?? [];
    group.push(activity);
    requests.set(requestId, group);
  }
  const replacements = new Map<OrchestrationThreadActivity, OrchestrationThreadActivity | null>();
  for (const [requestId, group] of requests) {
    const payloads = group.map((activity) => record(activity.payload)!);
    const questions = new Map<string, Record<string, unknown>>();
    const texts = new Map<string, unknown>();
    for (const payload of payloads) {
      for (const [id, text] of Object.entries(record(payload.questionTextById) ?? {}))
        texts.set(id, text);
      for (const value of Array.isArray(payload.questions) ? payload.questions : []) {
        const question = record(value);
        if (typeof question?.id !== "string") continue;
        questions.set(question.id, question);
        if (typeof question.question === "string") texts.set(question.id, question.question);
      }
    }
    const questionTextById = Object.fromEntries(texts);
    const submitted = group.findLast(
      (activity) =>
        activity.kind === "user-input.answer-submitted" &&
        record(record(activity.payload)?.answers),
    );
    const rawAnswers =
      record(record(submitted?.payload)?.answers) ??
      payloads.map((payload) => record(payload.answers)).findLast(Boolean) ??
      {};
    const answers = Object.fromEntries(
      Object.entries(rawAnswers).map(([id, value]) => {
        const options = questions.get(id)?.options;
        const labels = new Map<string, string>();
        for (const candidate of Array.isArray(options) ? options : []) {
          const option = record(candidate);
          if (typeof option?.value === "string" && typeof option.label === "string")
            labels.set(option.value, option.label);
        }
        return [id, displayOptionAnswer(value, labels)];
      }),
    );
    const attachmentsByQuestionId = Object.fromEntries(
      payloads.flatMap((payload) => Object.entries(record(payload.attachmentsByQuestionId) ?? {})),
    );
    const answer = { requestId, questionTextById, answers, attachmentsByQuestionId };
    if (!isQuestionAnswer(answer)) continue;
    const submittedAnswer =
      Object.keys(answers).length > 0 || Object.keys(attachmentsByQuestionId).length > 0;
    for (const activity of group) replacements.set(activity, null);
    replacements.set(group[0]!, {
      ...group[0]!,
      kind: "user-input.answer-submitted",
      tone: "tool",
      summary: submittedAnswer
        ? "User input submitted"
        : group.some((activity) => activity.kind === "user-input.resolved")
          ? "User input dismissed"
          : "User input requested",
      payload: answer,
    });
  }
  return withoutDuplicateQuestionTools(
    activities.flatMap((activity) => {
      const replacement = replacements.get(activity);
      return replacement === null ? [] : [replacement ?? activity];
    }),
  );
}

export function getQuestionAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(getQuestionAnswerText).filter(Boolean).join(", ");
  const nested = record(value);
  return nested ? getQuestionAnswerText(nested.answers) : "";
}

export function getQuestionAnswerPreview(answer: UserInputAttachmentAnswerPayload): string {
  const answers = Object.values(answer.answers).map(getQuestionAnswerText).filter(Boolean);
  const attachments = Object.values(answer.attachmentsByQuestionId)
    .flat()
    .map((attachment) => attachment.name);
  return (
    answers.length > 0
      ? answers.join(" · ")
      : attachments.length > 0
        ? attachments.join(", ")
        : Object.values(answer.questionTextById ?? {}).join(" · ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function hasQuestionAnswer(answer: UserInputAttachmentAnswerPayload): boolean {
  return (
    Object.values(answer.answers).some(getQuestionAnswerText) ||
    Object.values(answer.attachmentsByQuestionId).some((attachments) => attachments.length > 0)
  );
}
