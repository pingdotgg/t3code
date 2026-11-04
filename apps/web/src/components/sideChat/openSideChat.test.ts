import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClosedViewStore } from "../../closedViewStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { makeSideChatThreadFixture } from "../../test-fixtures";
import { toastManager } from "../ui/toast";
import { askInSideChat, type OpenSideChatRunner, openSideChatFromSelection } from "./openSideChat";
import {
  pendingSideChatThreadIds,
  selectStartingSideChat,
  usePendingSideChatStore,
} from "./pendingSideChatStore";

const environmentId = EnvironmentId.make("environment-test");
const lessonRef = scopeThreadRef(environmentId, ThreadId.make("lesson-1"));
const lessonKey = scopedThreadKey(lessonRef);
const messageId = MessageId.make("assistant-1");
const citation: AssistantCitation = {
  version: 1,
  environmentId,
  threadId: lessonRef.threadId,
  messageId,
  text: "observation space",
  start: 20,
  end: 37,
  prefix: "An ",
  suffix: " is what the agent can see.",
};
const refusal = AsyncResult.failure(
  Cause.fail(new Error("The highlighted reply is still streaming.")),
);

function deferredRunner() {
  let settleRun: (result: AtomCommandResult<unknown, unknown>) => void = () => {};
  const run = vi.fn<OpenSideChatRunner>(
    () =>
      new Promise((resolve) => {
        settleRun = resolve;
      }),
  );
  const startedThreadId = () => {
    const threadId = run.mock.calls[0]?.[0].input.threadId;
    if (threadId === undefined) throw new Error("The side chat was not dispatched.");
    return threadId;
  };
  return {
    run,
    startedThreadId,
    settle: (result: AtomCommandResult<unknown, unknown>) => settleRun(result),
  };
}

const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, lessonRef);
const pendingEntry = (threadId: ThreadId) =>
  usePendingSideChatStore.getState().byThreadKey[
    scopedThreadKey(scopeThreadRef(environmentId, threadId))
  ];

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  usePendingSideChatStore.setState({ byThreadKey: {} });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  vi.spyOn(threadEnvironment.finishSideChat, "run").mockImplementation(async () =>
    AsyncResult.success({ sequence: 1 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openSideChatFromSelection", () => {
  it("opens the side-chat tab before the server answers, un-maximizes the panel and sends the anchor", async () => {
    useRightPanelStore.getState().setMaximized(lessonRef, true);
    const { run, startedThreadId, settle } = deferredRunner();

    const outcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    });
    const threadId = startedThreadId();

    expect(run).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId,
        anchorThreadId: "lesson-1",
        anchor: {
          threadId: "lesson-1",
          messageId,
          start: 20,
          end: 37,
          prefix: "An ",
          suffix: " is what the agent can see.",
        },
        excerpt: "observation space",
      },
    });
    expect(panel()).toMatchObject({
      isOpen: true,
      activeSurfaceId: `side-chat:${threadId}`,
      surfaces: [{ id: `side-chat:${threadId}`, kind: "lesson-side-chat", threadId }],
    });
    expect(panel().maximized).toBeUndefined();
    expect(pendingEntry(threadId)).toEqual({
      threadId,
      lessonThreadKey: lessonKey,
      citation,
      status: "starting",
    });
    expect(selectStartingSideChat(usePendingSideChatStore.getState(), lessonKey)).toBe(true);

    settle(AsyncResult.success({ sequence: 1 }));

    await expect(outcome).resolves.toEqual({ _tag: "Opened", threadId });
    expect(pendingEntry(threadId)?.status).toBe("started");
    expect(selectStartingSideChat(usePendingSideChatStore.getState(), lessonKey)).toBe(false);
    expect(pendingSideChatThreadIds(usePendingSideChatStore.getState(), lessonKey)).toEqual([
      threadId,
    ]);
    expect(threadEnvironment.finishSideChat.run).not.toHaveBeenCalled();

    usePendingSideChatStore.getState().prune(lessonKey, new Set([threadId]));
    expect(usePendingSideChatStore.getState().byThreadKey).toEqual({});
  });

  it("closes the tab and reports why when the server refuses, without recording a closed view", async () => {
    const { run, startedThreadId, settle } = deferredRunner();

    const outcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    });
    const sideChatRef = scopeThreadRef(environmentId, startedThreadId());
    useComposerDraftStore.getState().setPrompt(sideChatRef, "What is a Box?");

    settle(refusal);

    await expect(outcome).resolves.toEqual({
      _tag: "Failed",
      message: "The highlighted reply is still streaming.",
    });
    expect(panel().surfaces).toEqual([]);
    expect(usePendingSideChatStore.getState().byThreadKey).toEqual({});
    expect(useClosedViewStore.getState().entries).toEqual([]);
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  });

  it("reports an interrupted open, and a failure that is not an error without its details", async () => {
    const interrupted = deferredRunner();
    const interruptedOutcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run: interrupted.run,
    });
    interrupted.settle(AsyncResult.failure(Cause.interrupt()));
    await expect(interruptedOutcome).resolves.toEqual({ _tag: "Interrupted" });

    const unexplained = deferredRunner();
    const unexplainedOutcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run: unexplained.run,
    });
    unexplained.settle(AsyncResult.failure(Cause.fail("offline")));
    await expect(unexplainedOutcome).resolves.toEqual({
      _tag: "Failed",
      message: "The side chat could not start.",
    });
    expect(panel().surfaces).toEqual([]);
  });

  it("reopens the existing side chat when the selection overlaps its highlight", async () => {
    const run = vi.fn<OpenSideChatRunner>();

    const outcome = await openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [
        makeSideChatThreadFixture({
          id: ThreadId.make("side-1"),
          lessonId: lessonRef.threadId,
          messageId,
          start: 22,
          end: 40,
          state: "done",
          noteStatus: "none",
        }),
      ],
      topThreadId: null,
      run,
    });

    expect(outcome).toEqual({ _tag: "Reused", threadId: "side-1" });
    expect(run).not.toHaveBeenCalled();
    expect(panel().surfaces).toEqual([
      { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
    ]);
  });

  it("opens a nested side chat inside its parent's tab and falls back to the parent on failure", async () => {
    useRightPanelStore
      .getState()
      .openLessonSideChat(lessonRef, { topThreadId: "side-1", threadId: "side-1" });
    const { run, startedThreadId, settle } = deferredRunner();

    const outcome = openSideChatFromSelection({
      lessonRef,
      citation: {
        ...citation,
        threadId: ThreadId.make("side-1"),
        messageId: MessageId.make("side-1-reply"),
      },
      sideChatShells: [],
      topThreadId: "side-1",
      run,
    });
    const threadId = startedThreadId();

    expect(run.mock.calls[0]?.[0].input.anchorThreadId).toBe("side-1");
    expect(panel().surfaces).toEqual([
      { id: "side-chat:side-1", kind: "lesson-side-chat", threadId },
    ]);

    settle(refusal);

    await expect(outcome).resolves.toMatchObject({ _tag: "Failed" });
    expect(panel().surfaces).toEqual([
      { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
    ]);
  });

  it("throws away a side chat whose tab was closed while it was starting, draft and all", async () => {
    const { run, startedThreadId, settle } = deferredRunner();

    const outcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    });
    const threadId = startedThreadId();
    const sideChatRef = scopeThreadRef(environmentId, threadId);
    useComposerDraftStore.getState().setPrompt(sideChatRef, "What");
    useComposerDraftStore
      .getState()
      .setModelSelection(
        sideChatRef,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5"),
      );
    useRightPanelStore.getState().closeSurface(lessonRef, `side-chat:${threadId}`);

    settle(AsyncResult.success({ sequence: 1 }));

    await expect(outcome).resolves.toEqual({ _tag: "Opened", threadId });
    expect(threadEnvironment.finishSideChat.run).toHaveBeenCalledWith(expect.anything(), {
      environmentId,
      input: { threadId },
    });
    expect(usePendingSideChatStore.getState().byThreadKey).toEqual({});
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  });

  it("keeps the draft of a closed side chat the server refused to throw away", async () => {
    vi.mocked(threadEnvironment.finishSideChat.run).mockImplementation(
      async () => refusal as never,
    );
    const { run, startedThreadId, settle } = deferredRunner();

    const outcome = openSideChatFromSelection({
      lessonRef,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    });
    const sideChatRef = scopeThreadRef(environmentId, startedThreadId());
    useComposerDraftStore.getState().setPrompt(sideChatRef, "What");
    useRightPanelStore.getState().closeSurface(lessonRef, `side-chat:${sideChatRef.threadId}`);

    settle(AsyncResult.success({ sequence: 1 }));

    await expect(outcome).resolves.toMatchObject({ _tag: "Opened" });
    expect(useComposerDraftStore.getState().getComposerDraft(sideChatRef)?.prompt).toBe("What");
  });
});

describe("askInSideChat", () => {
  it("says why the side chat couldn't start", async () => {
    const toast = new Promise<unknown>((resolve) => {
      vi.spyOn(toastManager, "add").mockImplementation((options) => {
        resolve(options);
        return "toast-1";
      });
    });
    const { run, settle } = deferredRunner();

    expect(askInSideChat({ lessonRef, citation, sideChatShells: [], topThreadId: null, run })).toBe(
      true,
    );
    settle(refusal);

    await expect(toast).resolves.toMatchObject({
      type: "error",
      title: "Couldn't start the side chat",
      description: "The highlighted reply is still streaming.",
    });
  });
});
