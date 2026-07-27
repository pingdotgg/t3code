import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setPendingUserInputCustomAnswer } from "./pendingUserInput";
import {
  clearPendingUserInputDraft,
  usePendingUserInputDraftStore,
  type PendingUserInputDraftAnswers,
} from "./pendingUserInputDraftStore";

const store = () => usePendingUserInputDraftStore.getState();
const answersFor = (requestId: string) => store().draftsByRequestId[requestId]?.answers;
const questionIndexFor = (requestId: string) => store().draftsByRequestId[requestId]?.questionIndex;

beforeEach(() => {
  usePendingUserInputDraftStore.setState({ draftsByRequestId: {} });
});

describe("pendingUserInputDraftStore", () => {
  it("keeps a custom answer available after the owning view unmounts", () => {
    store().updateAnswer("request-1", "question-1", (previous) =>
      setPendingUserInputCustomAnswer(previous, "this should survive"),
    );

    // A thread switch destroys `ChatView`; the store outlives it.
    expect(answersFor("request-1")?.["question-1"]).toEqual({
      customAnswer: "this should survive",
    });
  });

  it("keeps drafts for different requests isolated", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "first" }));
    store().updateAnswer("request-2", "question-1", () => ({ customAnswer: "second" }));

    expect(answersFor("request-1")?.["question-1"]?.customAnswer).toBe("first");
    expect(answersFor("request-2")?.["question-1"]?.customAnswer).toBe("second");
  });

  it("tracks the active question index per request without disturbing answers", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "answer" }));
    const answersBefore = answersFor("request-1");

    store().setQuestionIndex("request-1", 2);
    store().setQuestionIndex("request-2", 0);

    expect(questionIndexFor("request-1")).toBe(2);
    expect(questionIndexFor("request-2")).toBe(0);
    expect(answersFor("request-1")).toBe(answersBefore);
  });

  it("normalizes negative and fractional question indexes", () => {
    store().setQuestionIndex("request-1", -3);
    expect(questionIndexFor("request-1")).toBe(0);

    store().setQuestionIndex("request-1", 1.7);
    expect(questionIndexFor("request-1")).toBe(1);
  });

  it("drops a request's draft once the request is no longer pending", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "answer" }));
    store().setQuestionIndex("request-1", 1);
    store().updateAnswer("request-2", "question-1", () => ({ customAnswer: "other thread" }));

    clearPendingUserInputDraft("request-1");

    expect(store().draftsByRequestId["request-1"]).toBeUndefined();
    expect(answersFor("request-2")?.["question-1"]?.customAnswer).toBe("other thread");
  });

  it("removes a question entry when the updater returns undefined", () => {
    store().updateAnswer("request-1", "question-1", () => ({ customAnswer: "answer" }));
    store().updateAnswer("request-1", "question-1", () => undefined);

    expect(answersFor("request-1")).toEqual({});
  });

  it("stores a draft under a prototype-shadowing question id as an own property", () => {
    store().updateAnswer("request-1", "__proto__", () => ({ customAnswer: "answer" }));

    const requestAnswers = answersFor("request-1") as PendingUserInputDraftAnswers;
    expect(Object.hasOwn(requestAnswers, "__proto__")).toBe(true);
    // Must survive the JSON round-trip the persist middleware performs.
    expect(JSON.parse(JSON.stringify(requestAnswers))["__proto__"]).toEqual({
      customAnswer: "answer",
    });

    store().updateAnswer("request-1", "__proto__", () => undefined);
    expect(Object.hasOwn(answersFor("request-1") ?? {}, "__proto__")).toBe(false);
  });

  it("evicts the oldest drafts past the retention cap but keeps the active one", () => {
    for (let index = 0; index < 60; index += 1) {
      store().updateAnswer(`request-${index}`, "question-1", () => ({
        customAnswer: `answer-${index}`,
      }));
    }

    const retained = Object.keys(store().draftsByRequestId);
    expect(retained).toHaveLength(50);
    expect(retained).not.toContain("request-0");
    expect(retained).toContain("request-59");
  });

  it("evicts answers and question index together so neither half is orphaned", () => {
    for (let index = 0; index < 60; index += 1) {
      const requestId = `request-${index}`;
      store().updateAnswer(requestId, "question-1", () => ({ customAnswer: `answer-${index}` }));
      store().setQuestionIndex(requestId, 1);
    }

    for (const draft of Object.values(store().draftsByRequestId)) {
      expect(Object.keys(draft.answers)).toHaveLength(1);
      expect(draft.questionIndex).toBe(1);
    }
  });
});
