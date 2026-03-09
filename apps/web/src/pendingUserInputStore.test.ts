import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectPendingUserInputRequestState,
  usePendingUserInputStore,
} from "./pendingUserInputStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("pendingUserInputStore", () => {
  beforeEach(() => {
    usePendingUserInputStore.setState({ threadStateByThreadId: {} });
  });

  it("keeps question progress and answers isolated per thread and request", () => {
    const store = usePendingUserInputStore.getState();

    store.setQuestionIndex(THREAD_A, "request-1", 1);
    store.setQuestionAnswer(THREAD_A, "request-1", "question-1", {
      selectedOptionLabel: "Option A",
      customAnswer: "",
    });
    store.setQuestionIndex(THREAD_B, "request-1", 2);

    const threadARequest = selectPendingUserInputRequestState(
      usePendingUserInputStore.getState().threadStateByThreadId,
      THREAD_A,
      "request-1",
    );
    const threadBRequest = selectPendingUserInputRequestState(
      usePendingUserInputStore.getState().threadStateByThreadId,
      THREAD_B,
      "request-1",
    );

    expect(threadARequest).toEqual({
      questionIndex: 1,
      answersByQuestionId: {
        "question-1": {
          selectedOptionLabel: "Option A",
          customAnswer: "",
        },
      },
    });
    expect(threadBRequest).toEqual({
      questionIndex: 2,
      answersByQuestionId: {},
    });
  });

  it("drops request state once the thread no longer has that pending request", () => {
    const store = usePendingUserInputStore.getState();

    store.setQuestionIndex(THREAD_A, "request-1", 1);
    store.setQuestionAnswer(THREAD_A, "request-1", "question-1", {
      customAnswer: "custom",
    });
    store.syncThreadRequests(THREAD_A, new Set(["request-2"]));

    expect(
      selectPendingUserInputRequestState(
        usePendingUserInputStore.getState().threadStateByThreadId,
        THREAD_A,
        "request-1",
      ),
    ).toEqual({
      questionIndex: 0,
      answersByQuestionId: {},
    });
    expect(usePendingUserInputStore.getState().threadStateByThreadId[THREAD_A]).toBeUndefined();
  });
});
