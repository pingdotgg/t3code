import { ApprovalRequestId, EventId, TurnId, type UserInputQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSlackUserInputAnswers, derivePendingExternalUserInputs } from "./userInputSlack.ts";

const frameworkQuestion: UserInputQuestion = {
  id: "Which framework?",
  header: "Framework",
  question: "Which framework?",
  options: [
    { label: "React", description: "React.js" },
    { label: "Vue", description: "Vue.js" },
  ],
  multiSelect: false,
};

const areasQuestion: UserInputQuestion = {
  id: "Which areas?",
  header: "Areas",
  question: "Which areas should be changed?",
  options: [
    { label: "Server", description: "API and workers" },
    { label: "Web", description: "Frontend" },
  ],
  multiSelect: true,
};

describe("buildSlackUserInputAnswers", () => {
  it("maps a one-question Slack reply to the question id Claude expects", () => {
    expect(buildSlackUserInputAnswers([frameworkQuestion], "React")).toEqual({
      "Which framework?": "React",
    });
  });

  it("accepts numeric option replies", () => {
    expect(buildSlackUserInputAnswers([frameworkQuestion], "2")).toEqual({
      "Which framework?": "Vue",
    });
  });

  it("parses numbered multi-question replies", () => {
    expect(
      buildSlackUserInputAnswers([frameworkQuestion, areasQuestion], "1. React\n2. 1, 2"),
    ).toEqual({
      "Which framework?": "React",
      "Which areas?": ["Server", "Web"],
    });
  });

  it("does not submit partial multi-question replies", () => {
    expect(buildSlackUserInputAnswers([frameworkQuestion, areasQuestion], "1. React")).toBeNull();
  });
});

describe("derivePendingExternalUserInputs", () => {
  it("returns unresolved user input requests", () => {
    expect(
      derivePendingExternalUserInputs([
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "request-1",
            questions: [frameworkQuestion],
          },
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          sequence: 1,
        },
      ]),
    ).toEqual([
      {
        requestId: ApprovalRequestId.make("request-1"),
        questions: [frameworkQuestion],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops requests after user-input.resolved", () => {
    expect(
      derivePendingExternalUserInputs([
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "request-1",
            questions: [frameworkQuestion],
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          sequence: 1,
        },
        {
          id: EventId.make("activity-2"),
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            requestId: "request-1",
            answers: { "Which framework?": "React" },
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
          sequence: 2,
        },
      ]),
    ).toEqual([]);
  });
});
