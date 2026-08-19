/**
 * T3-authored Continuation instructions sent into a Turn.
 *
 * The English word "goal", `/goal`, and "slash goal" must never appear in
 * T3-authored provider text (ADR 0013). The user's Objective is interpolated
 * as-is and may contain the word "goal".
 */

const OBJECTIVE_PLACEHOLDER = "{{objective}}";

const CONTINUATION_TEMPLATE = [
  "Continue working toward this Objective until the outcome is true:",
  "",
  "```",
  OBJECTIVE_PLACEHOLDER,
  "```",
  "",
  "When the outcome is true, emit <objective_complete>…</objective_complete> with brief evidence.",
  "When you cannot make progress, emit <objective_blocked>…</objective_blocked> with what is blocking you.",
  "Emit those tags only from evidence, not from hope or politeness.",
].join("\n");

export function buildGoalContinuationPrompt(objective: string): string {
  // Function replacer: a string replacement would let `$&`-style tokens in the
  // Objective rewrite the prompt.
  return CONTINUATION_TEMPLATE.replace(OBJECTIVE_PLACEHOLDER, () => objective);
}

export function goalContinuationCommandId(input: {
  readonly threadId: string;
  readonly goalUpdatedAt: string;
  readonly completedTurnId: string;
}): string {
  return `goal-continue:${input.threadId}:${input.goalUpdatedAt}:${input.completedTurnId}`;
}

export function goalBlockCommandId(input: {
  readonly threadId: string;
  readonly goalUpdatedAt: string;
  readonly completedTurnId: string;
}): string {
  return `goal-block:${input.threadId}:${input.goalUpdatedAt}:${input.completedTurnId}`;
}

const USAGE_LIMIT_ERROR_PATTERN =
  /\b429\b|too many requests|rate[\s_-]*limit|usage[\s_-]*limit|\bquota\b|resource_exhausted|tokens? (?:limit|exhausted)/i;

/** True when a Turn error means the provider account cannot accept more work. */
export function isProviderAccountUsageLimitError(message: string | null | undefined): boolean {
  if (message == null || message.trim().length === 0) {
    return false;
  }
  return USAGE_LIMIT_ERROR_PATTERN.test(message);
}

export const EMPTY_GOAL_CONTINUATION_LIMIT = 3;

const OBJECTIVE_COMPLETE_TAG = /<objective_complete>([\s\S]*?)<\/objective_complete>/;
const OBJECTIVE_BLOCKED_TAG = /<objective_blocked>([\s\S]*?)<\/objective_blocked>/;

export type ObjectiveSignal = "complete" | "blocked";

/** First structured Complete/Blocked tag in assistant text. Prose is ignored. */
export function parseObjectiveSignal(text: string): ObjectiveSignal | null {
  const complete = OBJECTIVE_COMPLETE_TAG.exec(text);
  const blocked = OBJECTIVE_BLOCKED_TAG.exec(text);
  const completeIndex = complete?.index;
  const blockedIndex = blocked?.index;
  if (completeIndex === undefined && blockedIndex === undefined) {
    return null;
  }
  if (completeIndex === undefined) {
    return "blocked";
  }
  if (blockedIndex === undefined) {
    return "complete";
  }
  return completeIndex <= blockedIndex ? "complete" : "blocked";
}

export function countTrailingEmptyGoalContinuations(
  thread: {
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly tone: string;
      readonly createdAt: string;
    }>;
    readonly checkpoints: ReadonlyArray<{
      readonly files: ReadonlyArray<{ readonly additions?: number; readonly deletions?: number }>;
      readonly completedAt: string;
    }>;
  },
  occurredAt: string,
): number {
  let resetAt = "";
  for (const activity of thread.activities) {
    if (
      (activity.kind === "goal.set" || activity.kind === "goal.resumed") &&
      activity.createdAt > resetAt
    ) {
      resetAt = activity.createdAt;
    }
  }
  const continuations = thread.activities
    .filter((activity) => activity.kind === "goal.continued" && activity.createdAt >= resetAt)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (continuations.length === 0) {
    return 0;
  }

  const windowIsEmpty = (start: string, end: string, endInclusive: boolean): boolean => {
    const inWindow = (timestamp: string) =>
      timestamp >= start && (endInclusive ? timestamp <= end : timestamp < end);
    const hasTool = thread.activities.some(
      (activity) => activity.tone === "tool" && inWindow(activity.createdAt),
    );
    const hasDiff = thread.checkpoints.some(
      (checkpoint) => inWindow(checkpoint.completedAt) && checkpoint.files.length > 0,
    );
    return !hasTool && !hasDiff;
  };

  let trailing = 0;
  for (let index = continuations.length - 1; index >= 0; index -= 1) {
    const start = continuations[index]?.createdAt;
    if (start === undefined) {
      break;
    }
    const next = continuations[index + 1]?.createdAt;
    const empty =
      next === undefined
        ? windowIsEmpty(start, occurredAt, true)
        : windowIsEmpty(start, next, false);
    if (!empty) {
      break;
    }
    trailing += 1;
  }
  return trailing;
}
