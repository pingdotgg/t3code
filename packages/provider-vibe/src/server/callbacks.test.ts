import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { vibeCallback, vibeQuestionResult } from "./callbacks.ts";

const isQuestion = Schema.is(OrchestrationV2UserInputQuestion);

const request = {
  callback: {
    type: "callback",
    id: "input-1",
    callbackId: "input-1",
    title: "User input required",
    detail: {
      kind: "user_input",
      request: {
        questions: [
          {
            question: "Which network?",
            header: "",
            options: [
              { label: "Home", description: "" },
              { label: "Proximus", description: "New location" },
            ],
            multiSelect: false,
            hideOther: false,
          },
        ],
      },
    },
    state: { status: "open" },
  },
};

describe("native Vibe callbacks", () => {
  it("recognizes the nested user-input detail and produces client-compatible questions", () => {
    const callback = vibeCallback(request);
    expect(callback?.kind).toBe("user_input");
    expect(callback?.callbackId).toBe("input-1");
    expect(callback?.questions).toEqual([
      {
        id: "question-0",
        header: "Question 1",
        question: "Which network?",
        options: [
          { label: "Home", description: "Home" },
          { label: "Proximus", description: "New location" },
        ],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ]);
    for (const question of callback?.questions ?? []) {
      expect(isQuestion(question)).toBe(true);
    }
  });

  it("answers with the original prompt rather than the generated client id", () => {
    const questions = vibeCallback(request)!.questions;
    expect(vibeQuestionResult(questions, { "question-0": "Proximus" }, false)).toEqual({
      type: "user_input",
      result: {
        answers: [{ question: "Which network?", answer: "Proximus", isOther: false }],
        cancelled: false,
      },
    });
    expect(
      vibeQuestionResult(questions, { "question-0": "Guest network" }, false).result.answers[0],
    ).toMatchObject({
      answer: "Guest network",
      isOther: true,
    });
    expect(vibeQuestionResult(questions, { "question-0": "Home" }, true).result).toEqual({
      answers: [],
      cancelled: true,
    });
  });

  it("preserves multiple selection and hides custom input when requested", () => {
    const source = structuredClone(request);
    source.callback.detail.request.questions[0]!.multiSelect = true;
    source.callback.detail.request.questions[0]!.hideOther = true;
    const questions = vibeCallback(source)!.questions;
    expect(questions[0]).toMatchObject({ multiSelect: true, allowCustomAnswer: false });
    expect(
      vibeQuestionResult(questions, { "question-0": ["Home", "Proximus"] }, false).result
        .answers[0],
    ).toEqual({
      question: "Which network?",
      answer: "Home, Proximus",
      isOther: false,
    });
  });

  it("keeps actual approvals separate and rejects unsupported or malformed callbacks", () => {
    expect(
      vibeCallback({ callback: { callbackId: "approval-1", detail: { kind: "approval" } } }),
    ).toEqual({
      callbackId: "approval-1",
      kind: "permission",
      questions: [],
    });
    expect(
      vibeCallback({ callback: { callbackId: "unknown", detail: { kind: "connector_auth" } } }),
    ).toBeUndefined();
    expect(
      vibeCallback({
        callback: { callbackId: "bad", detail: { kind: "user_input", request: { questions: [] } } },
      }),
    ).toBeUndefined();
  });
});
