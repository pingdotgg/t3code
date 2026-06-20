import type { OrchestrationThreadActivity } from "@t3tools/contracts";

// Pending provider user-input requests derived from the activity stream — the
// TUI port of the web client's derivePendingUserInputs. A `user-input.requested`
// activity opens a request (a list of questions, each with options); a later
// `user-input.resolved` (or a stale-request failure) closes it. Mirrors the
// approval derivation in approvals.ts.

export interface UserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface UserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<UserInputOption>;
  readonly multiSelect: boolean;
}

export interface PendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseQuestions(payload: Record<string, unknown> | null): UserInputQuestion[] | null {
  const raw = payload?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: UserInputQuestion[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.header !== "string" ||
      typeof record.question !== "string" ||
      !Array.isArray(record.options)
    ) {
      continue;
    }
    const options: UserInputOption[] = [];
    for (const option of record.options) {
      const optionRecord = asRecord(option);
      if (
        optionRecord &&
        typeof optionRecord.label === "string" &&
        typeof optionRecord.description === "string"
      ) {
        options.push({ label: optionRecord.label, description: optionRecord.description });
      }
    }
    questions.push({
      id: record.id,
      header: record.header,
      question: record.question,
      options,
      multiSelect: record.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

function isStaleFailure(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request")
  );
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const open = new Map<string, PendingUserInput>();
  const ordered = [...activities].sort((a, b) => {
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.createdAt.localeCompare(b.createdAt);
  });

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested") {
      const questions = parseQuestions(payload);
      if (questions) open.set(requestId, { requestId, createdAt: activity.createdAt, questions });
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      open.delete(requestId);
      continue;
    }
    if (activity.kind === "provider.user-input.respond.failed" && isStaleFailure(detail)) {
      open.delete(requestId);
    }
  }

  return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Build the `respondToThreadUserInput` answers payload (keyed by question id):
 * a single label for single-select questions, an array for multi-select.
 */
export function buildUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  selections: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const selected = selections[question.id] ?? [];
    answers[question.id] = question.multiSelect ? [...selected] : (selected[0] ?? "");
  }
  return answers;
}

/** Whether every question has at least one selection (ready to submit). */
export function isUserInputComplete(
  questions: ReadonlyArray<UserInputQuestion>,
  selections: Readonly<Record<string, ReadonlyArray<string>>>,
): boolean {
  return questions.every((question) => (selections[question.id]?.length ?? 0) > 0);
}
