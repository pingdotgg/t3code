import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { questionAttachmentDraftId } from "../../questionAttachments";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

let requests: ReturnType<typeof usePendingThreadRequests>;

function PendingRequestsProbe({
  environmentId,
  projection,
  loading = false,
  composerDraftTarget,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  composerDraftTarget?: DraftId;
}) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    activeThread: projection.thread,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: composerDraftTarget ?? { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
  useLayoutEffect(() => {
    requests = state;
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <PendingRequestsProbe environmentId={environmentId} projection={projection} loading={loading} />
  );
  await using screen = await render(probe());
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: ComponentProps<typeof PendingRequestsProbe>) =>
    screen.rerender(<PendingRequestsProbe {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(0);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => requests.onAdvanceActivePendingUserInput());
  }

  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(requests.activePendingUserInput?.requestId).toBe("second");
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

// Stop cancels an open question; a provider timeout expires it. Neither sends the answer.
it.each(["cancelled", "expired"] as const)(
  "keeps a typed answer and its thread chips in the thread draft when the question is %s",
  async (status) => {
    using _timers = fakeTimers();
    const environmentId = EnvironmentId.make(`${status}-environment`);
    const projection = questionProjection(threadRef.threadId, ["first"]);
    const reference = threadContextRecord(
      { environmentId, threadId: ThreadId.make("reference-thread") },
      "Reference work",
    );
    const answer = `Purple please, like ${formatInlineContextReference(threadContextReference(reference))}`;
    const draftTarget = { environmentId, threadId: threadRef.threadId };
    useComposerDraftStore.getState().setPrompt(draftTarget, "Earlier draft");
    useComposerDraftStore
      .getState()
      .setThreadContexts(
        questionAttachmentDraftId(environmentId, threadRef.threadId, "first", "question-0"),
        [reference],
      );
    await using screen = await render(
      <PendingRequestsProbe environmentId={environmentId} projection={projection} />,
    );
    await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", answer));
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(answer);

    await screen.rerender(
      <PendingRequestsProbe
        environmentId={environmentId}
        projection={{
          ...projection,
          runtimeRequests: projection.runtimeRequests.map((request) => ({
            ...request,
            status,
            resolvedAt: projection.updatedAt,
          })),
        }}
      />,
    );
    expect(requests.activePendingUserInput).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)).toMatchObject({
      prompt: `Earlier draft\n\n${answer}`,
      threadContexts: [reference],
    });
  },
);

it("does not return an answer to the thread draft once the question is resolved", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("resolve-environment");
  const projection = questionProjection(threadRef.threadId, ["first"]);
  await using screen = await render(
    <PendingRequestsProbe environmentId={environmentId} projection={projection} />,
  );
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Sent"));
  await screen.rerender(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={{
        ...projection,
        runtimeRequests: projection.runtimeRequests.map((request) => ({
          ...request,
          status: "resolved",
          resolvedAt: projection.updatedAt,
        })),
      }}
    />,
  );
  expect(
    useComposerDraftStore
      .getState()
      .getComposerDraft({ environmentId, threadId: threadRef.threadId })?.prompt ?? "",
  ).toBe("");
});

it("keeps a cancelled question's typed answer when a queued-message edit is open and then cancelled", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("queued-edit-environment");
  const projection = questionProjection(threadRef.threadId, ["first"]);
  const answer = "Typed while a queued message was being edited.";
  const threadTarget = { environmentId, threadId: threadRef.threadId };
  // The composer shows the queued edit's temporary draft, not the thread's.
  const editTarget = DraftId.make("queued-edit:test:run");
  useComposerDraftStore.getState().setPrompt(editTarget, "Queued message text");
  await using screen = await render(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={projection}
      composerDraftTarget={editTarget}
    />,
  );
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", answer));
  await screen.rerender(
    <PendingRequestsProbe
      environmentId={environmentId}
      composerDraftTarget={editTarget}
      projection={{
        ...projection,
        runtimeRequests: projection.runtimeRequests.map((request) => ({
          ...request,
          status: "cancelled",
          resolvedAt: projection.updatedAt,
        })),
      }}
    />,
  );
  // Cancelling the queued edit clears its temporary draft.
  useComposerDraftStore.getState().clearComposerContent(editTarget);
  expect(useComposerDraftStore.getState().getComposerDraft(threadTarget)?.prompt).toBe(answer);
});
