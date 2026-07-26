import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setPendingUserInputCustomAnswer } from "./pendingUserInput";
import {
  clearPendingUserInputDraft,
  usePendingUserInputDraftStore,
} from "./pendingUserInputDraftStore";

const store = () => usePendingUserInputDraftStore.getState();

beforeEach(() => {
  usePendingUserInputDraftStore.setState({
    answersByRequestId: {},
    questionIndexByRequestId: {},
  });
});

describe("pendingUserInputDraftStore", () => {
  it("keeps a custom answer available after the owning view unmounts", () => {
    store().updateAnswer("request-1", "question-1", (previous) =>
      setPendingUserInputCustomAnswer(previous, "this should survive"),
    );

    // A thread switch destroys `ChatView`; the store outlives it.
    expect(store().answersByRequestId["request-1"]?.["question-1"]).toEqual({
      customAnswer: "this should survive",
    });
  });

  it("keeps drafts for different requests isolated", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "first" }));
    store().updateAnswer("request-2", "question-1", () => ({ customAnswer: "second" }));

    expect(store().answersByRequestId["request-1"]?.["question-1"]?.customAnswer).toBe("first");
    expect(store().answersByRequestId["request-2"]?.["question-1"]?.customAnswer).toBe("second");
  });

  it("tracks the active question index per request", () => {
    store().setQuestionIndex("request-1", 2);
    store().setQuestionIndex("request-2", 0);

    expect(store().questionIndexByRequestId["request-1"]).toBe(2);
    expect(store().questionIndexByRequestId["request-2"]).toBe(0);
  });

  it("normalizes negative and fractional question indexes", () => {
    store().setQuestionIndex("request-1", -3);
    expect(store().questionIndexByRequestId["request-1"]).toBe(0);

    store().setQuestionIndex("request-1", 1.7);
    expect(store().questionIndexByRequestId["request-1"]).toBe(1);
  });

  it("drops a request's draft once its answer is submitted", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "answer" }));
    store().setQuestionIndex("request-1", 1);
    store().updateAnswer("request-2", "question-1", () => ({ customAnswer: "other thread" }));

    clearPendingUserInputDraft("request-1");

    expect(store().answersByRequestId["request-1"]).toBeUndefined();
    expect(store().questionIndexByRequestId["request-1"]).toBeUndefined();
    expect(store().answersByRequestId["request-2"]?.["question-1"]?.customAnswer).toBe(
      "other thread",
    );
  });

  it("removes a question entry when the updater returns undefined", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "answer" }));
    store().updateAnswer("request-1", "question-1", () => undefined);

    expect(store().answersByRequestId["request-1"]).toEqual({});
  });

  it("evicts the oldest drafts past the retention cap but keeps the active one", () => {
    for (let index = 0; index < 60; index += 1) {
      store().updateAnswer(`request-${index}`, "question-1", () => ({
        customAnswer: `answer-${index}`,
      }));
    }

    const retained = Object.keys(store().answersByRequestId);
    expect(retained).toHaveLength(50);
    expect(retained).not.toContain("request-0");
    expect(retained).toContain("request-59");
  });
});
