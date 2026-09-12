import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act, useLayoutEffect, useMemo, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { pendingUserInputRequestKey } from "../ChatView.logic";
import { usePendingUserInputDraft } from "./usePendingUserInputDraft";

const environmentId = EnvironmentId.make("environment-a");
const otherEnvironmentId = EnvironmentId.make("environment-b");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const request = { requestId: "request", questions: [{ id: "question" }, { id: "question-two" }] };
const ownerA = scopeThreadRef(environmentId, threadA);
let renderer: ReactTestRenderer;
let composer: {
  target: ScopedThreadRef;
  answer: string;
  edit: (value: string, questionId?: string) => void;
  selectOption: (questionId: string) => void;
  submit: (response: Promise<void>) => Promise<void>;
};

// Like the unkeyed server route, navigation changes props on the same mounted
// composer. useMemo allocates a new scoped reference when returning to A.
function Composer({
  threadId,
  environment = environmentId,
  pending,
}: {
  threadId: ThreadId;
  environment?: EnvironmentId;
  pending: boolean;
}) {
  const target = useMemo(() => scopeThreadRef(environment, threadId), [environment, threadId]);
  const [answers, setAnswers] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const lifecycle = usePendingUserInputDraft({
    composerDraftTarget: target,
    activePendingUserInput: pending ? request : null,
    pendingUserInputAnswersByRequestId: answers,
    setPendingUserInputAnswersByRequestId: setAnswers,
  });
  const key = pendingUserInputRequestKey(target, request.requestId);
  useLayoutEffect(() => {
    composer = {
      target,
      answer: answers[key]?.question?.customAnswer ?? "",
      edit(value, questionId = "question") {
        setAnswers((existing) => ({
          ...existing,
          [key]: {
            ...existing[key],
            [questionId]: setPendingUserInputCustomAnswer(existing[key]?.[questionId], value),
          },
        }));
      },
      selectOption(questionId) {
        lifecycle.returnQuestionTextToComposerDraft(
          request.requestId,
          answers[key]?.[questionId]?.customAnswer ?? "",
          target,
        );
        setAnswers((existing) => ({
          ...existing,
          [key]: {
            ...existing[key],
            [questionId]: { customAnswer: "", selectedOptionValues: ["selected"] },
          },
        }));
      },
      async submit(response) {
        const restoreFailure = lifecycle.beginSubmission(request.requestId);
        try {
          await response;
        } catch {
          restoreFailure();
        }
      },
    };
  });
  return null;
}
async function navigate(threadId: ThreadId, pending: boolean, environment = environmentId) {
  await act(() =>
    renderer.update(<Composer threadId={threadId} pending={pending} environment={environment} />),
  );
}
function prompt(target = ownerA) {
  return useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(ownerA, "original draft");
  await act(() => {
    renderer = create(<Composer threadId={threadA} pending={false} />);
  });
  await navigate(threadA, true);
  expect(composer.answer).toBe("original draft");
});
afterEach(async () => {
  await act(() => renderer.unmount());
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  vi.unstubAllGlobals();
});
describe("pending answer draft ownership through mounted navigation", () => {
  it("does not resurrect an erased carried answer after A to B to A and Stop", async () => {
    const initialTarget = composer.target;
    await navigate(threadB, false);
    await navigate(threadA, true);
    expect(composer.target).toEqual(initialTarget);
    expect(composer.target).not.toBe(initialTarget);
    await act(() => composer.edit(""));
    await navigate(threadA, false);
    expect(prompt()).toBe("");
  });
  it("replaces the persisted carried copy with the edited answer after returning and Stop", async () => {
    await navigate(threadB, false);
    await navigate(threadA, true);
    await act(() => composer.edit("edited answer"));
    await navigate(threadA, false);
    expect(prompt()).toBe("edited answer");
  });
  it("rescues a failed response when A is revisited after the question disappeared", async () => {
    await act(() => composer.edit("edited answer"));
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    let submission!: Promise<void>;
    await act(() => {
      submission = composer.submit(response);
    });
    expect(prompt()).toBe("");
    await navigate(threadB, false);
    await navigate(threadA, false);
    await act(async () => {
      rejectResponse(new Error("response failed"));
      await submission;
    });
    expect(prompt()).toBe("edited answer");
  });
  it("does not rescue a failed response into an identically named thread in another environment", async () => {
    await act(() => composer.edit("edited answer"));
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    let submission!: Promise<void>;
    await act(() => {
      submission = composer.submit(response);
    });
    const otherOwner = scopeThreadRef(otherEnvironmentId, threadA);
    useComposerDraftStore.getState().setPrompt(otherOwner, "other draft");
    await navigate(threadA, false, otherEnvironmentId);
    await act(async () => {
      rejectResponse(new Error("response failed"));
      await submission;
    });
    expect(prompt(otherOwner)).toBe("other draft");
    expect(prompt()).toBe("edited answer");
    await navigate(threadA, true);
    await navigate(threadA, false);
    expect(prompt()).toBe("edited answer");
  });

  it.each(["disappear", "edit", "erase", "retry"])(
    "persists an offscreen failed answer and preserves unrelated text on %s",
    async (nextAction) => {
      await act(() => composer.edit("edited answer"));
      let rejectResponse!: (error: Error) => void;
      const response = new Promise<void>((_resolve, reject) => {
        rejectResponse = reject;
      });
      let submission!: Promise<void>;
      await act(() => {
        submission = composer.submit(response);
      });
      await navigate(threadB, false);
      useComposerDraftStore.getState().setPrompt(ownerA, "unrelated draft");
      await act(async () => {
        rejectResponse(new Error("response failed"));
        await submission;
      });
      expect(prompt()).toBe("unrelated draft\n\nedited answer");
      if (nextAction === "disappear") {
        await navigate(threadA, false);
        expect(prompt()).toBe("unrelated draft\n\nedited answer");
        return;
      }
      await navigate(threadA, true);
      if (nextAction === "retry") {
        await act(() => composer.submit(Promise.resolve()));
      } else {
        await act(() => composer.edit(nextAction === "erase" ? "" : "new answer"));
      }
      await navigate(threadA, false);
      expect(prompt()).toBe(
        nextAction === "edit" ? "unrelated draft\n\nnew answer" : "unrelated draft",
      );
    },
  );

  it.each(["question", "question-two"])(
    "preserves the other failed answer after erasing %s and an offscreen cancellation",
    async (questionId) => {
      await act(() => composer.edit("answer one"));
      await act(() => composer.edit("answer two", "question-two"));
      await act(() => composer.submit(Promise.reject(new Error("response failed"))));
      expect(prompt()).toBe("answer one\n\nanswer two");
      await act(() => composer.edit("", questionId));
      await navigate(threadB, false);
      await navigate(threadA, false);
      expect(prompt()).toBe(questionId === "question" ? "answer two" : "answer one");
    },
  );

  it.each(["disappear", "edit", "erase", "retry"])(
    "retains other answers and unrelated text after choosing an option then %s",
    async (nextAction) => {
      await act(() => composer.edit("answer one"));
      await act(() => composer.edit("answer two", "question-two"));
      useComposerDraftStore.getState().setPrompt(ownerA, "unrelated draft");
      await act(() => composer.submit(Promise.reject(new Error("response failed"))));
      await act(() => composer.selectOption("question"));
      expect(prompt()).toBe("unrelated draft\n\nanswer one\n\nanswer two");
      await navigate(threadB, false);
      if (nextAction !== "disappear") {
        await navigate(threadA, true);
        if (nextAction === "retry") {
          await act(() => composer.submit(Promise.resolve()));
        } else {
          await act(() =>
            composer.edit(nextAction === "edit" ? "updated answer two" : "", "question-two"),
          );
        }
        await navigate(threadB, false);
      }
      await navigate(threadA, false);
      expect(prompt()).toBe(
        "unrelated draft\n\nanswer one" +
          (nextAction === "disappear"
            ? "\n\nanswer two"
            : nextAction === "edit"
              ? "\n\nupdated answer two"
              : ""),
      );
    },
  );

  it("does not rescue a submitted answer when returning before its resolution", async () => {
    let resolveResponse!: () => void;
    const response = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    let submission!: Promise<void>;
    await act(() => {
      submission = composer.submit(response);
    });
    await navigate(threadB, false);
    await navigate(threadA, true);
    await navigate(threadA, false);
    await act(async () => {
      resolveResponse();
      await submission;
    });
    expect(prompt()).toBe("");
  });
  it("keeps reused thread and request ids in another environment independent", async () => {
    const otherOwner = scopeThreadRef(otherEnvironmentId, threadA);
    useComposerDraftStore.getState().setPrompt(otherOwner, "other draft");
    await navigate(threadA, true, otherEnvironmentId);
    expect(composer.answer).toBe("other draft");
    await act(() => composer.edit("other answer"));
    await navigate(threadA, false, otherEnvironmentId);
    expect(prompt(otherOwner)).toBe("other answer");
    expect(prompt()).toBe("original draft");
    await navigate(threadA, true);
    expect(composer.answer).toBe("original draft");
  });
});
