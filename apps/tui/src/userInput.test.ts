import { describe, expect, it } from "bun:test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  buildUserInputAnswers,
  derivePendingUserInputs,
  isUserInputComplete,
  type UserInputQuestion,
} from "./userInput.ts";

let seq = 0;
function activity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  seq += 1;
  return {
    id: `a${seq}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    sequence: seq,
    createdAt: `2026-06-19T00:00:0${seq}.000Z`,
  } as OrchestrationThreadActivity;
}

const question = (over: Partial<UserInputQuestion> = {}): UserInputQuestion => ({
  id: "q1",
  header: "Database",
  question: "Which driver?",
  options: [
    { label: "Postgres", description: "pg" },
    { label: "SQLite", description: "sqlite" },
  ],
  multiSelect: false,
  ...over,
});

const requestPayload = (requestId: string, questions: ReadonlyArray<UserInputQuestion>) => ({
  requestId,
  questions: questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
});

describe("derivePendingUserInputs", () => {
  it("Given a user-input.requested activity, then it parses the request and its questions", () => {
    const pending = derivePendingUserInputs([
      activity("user-input.requested", requestPayload("r1", [question()])),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe("r1");
    expect(pending[0]!.questions[0]!.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
  });

  it("Given a later user-input.resolved, then the request is closed", () => {
    const pending = derivePendingUserInputs([
      activity("user-input.requested", requestPayload("r1", [question()])),
      activity("user-input.resolved", { requestId: "r1" }),
    ]);
    expect(pending).toHaveLength(0);
  });

  it("Given a malformed request (no questions), then it is ignored", () => {
    expect(derivePendingUserInputs([activity("user-input.requested", { requestId: "r1" })])).toHaveLength(0);
  });
});

describe("buildUserInputAnswers / isUserInputComplete", () => {
  it("Given a single-select question, then the answer is the chosen label", () => {
    const answers = buildUserInputAnswers([question()], { q1: ["Postgres"] });
    expect(answers).toEqual({ q1: "Postgres" });
  });

  it("Given a multi-select question, then the answer is an array of labels", () => {
    const answers = buildUserInputAnswers([question({ id: "q2", multiSelect: true })], {
      q2: ["Postgres", "SQLite"],
    });
    expect(answers).toEqual({ q2: ["Postgres", "SQLite"] });
  });

  it("reports completeness only when every question has a selection", () => {
    const questions = [question(), question({ id: "q2" })];
    expect(isUserInputComplete(questions, { q1: ["Postgres"] })).toBe(false);
    expect(isUserInputComplete(questions, { q1: ["Postgres"], q2: ["SQLite"] })).toBe(true);
  });
});
