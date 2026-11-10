import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const submission = vi.hoisted(() => ({ refresh: vi.fn(), respond: vi.fn(), error: vi.fn() }));
vi.mock(import("../../lib/attachmentUploadQueue"), async (importOriginal) => ({
  ...(await importOriginal()),
  refreshExpiredAttachmentUploads: submission.refresh,
  getUploadedAttachments: () => [],
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => submission.respond) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { toastManager } from "../ui/toast";
import { usePendingThreadRequests } from "./usePendingThreadRequests";
import { questionAttachmentDraftId } from "../../questionAttachments";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";

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

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
}

function useProbeRequests({ environmentId, projection, loading = false }: ProbeProps) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  return usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: true,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: submission.error,
  });
}

let requests: ReturnType<typeof usePendingThreadRequests>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("preserves an answer edited after remount while attachment preparation is in flight", async () => {
  const environmentId = EnvironmentId.make("editing-during-refresh");
  const projection = questionProjection(ThreadId.make("editing-during-refresh"), ["first"]);
  const requestId = RuntimeRequestId.make("first");
  const target = questionAttachmentDraftId(
    environmentId,
    projection.thread.id,
    requestId,
    "question-0",
  );
  const file = new File(["image"], "image.png", { type: "image/png" });
  useComposerDraftStore.getState().addImages(target, [
    {
      type: "image",
      id: "editing-upload",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:editing-upload",
    },
  ]);
  const started = deferred();
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      "editing-upload": { status: "ready", environmentId, attachmentId: "pending-editing-upload" },
    },
  });
  const release = deferred();
  const rejected = deferred();
  submission.respond.mockClear();
  submission.error.mockClear();
  submission.error.mockImplementationOnce(() => rejected.resolve());
  submission.refresh.mockImplementationOnce(() => {
    started.resolve();
    return release.promise;
  });
  const probe = <PendingRequestsProbe environmentId={environmentId} projection={projection} />;
  await using screen = await render(probe);
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Original"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-1", "Second"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-2", "Third"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  expect(submission.refresh).toHaveBeenCalledOnce();
  await started.promise;
  await screen.rerender(null);
  await screen.rerender(probe);
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Edited"));
  await act(async () => {
    release.resolve();
    await rejected.promise;
  });
  expect(submission.respond).not.toHaveBeenCalled();
  expect(submission.error).toHaveBeenCalledWith(
    projection.thread.id,
    "Answer changed while preparing attachments. Review it and send again.",
  );
  expect(requests.activePendingDraftAnswers["question-0"]).toMatchObject({
    customAnswer: "Edited",
  });
});

function PendingRequestsProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
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

it("tells the user when an option click moves their typed answer into the hidden composer draft", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("displaced-environment");
  const draftTarget = { environmentId, threadId: threadRef.threadId };
  const draftPrompt = () => useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt;
  using toast = vi.spyOn(toastManager, "add");
  await using _screen = await render(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={questionProjection(threadRef.threadId)}
    />,
  );

  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  expect(toast).not.toHaveBeenCalled();

  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "first try"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  expect(draftPrompt()).toBe("first try");
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "info",
      title: "Your typed text was set aside",
      description: "It will be back in the composer once the question is answered.",
      data: { threadRef: draftTarget },
    }),
  );

  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "second try"));
  expect(draftPrompt()).toBe("first try");
  expect(requests.activePendingDraftAnswers["question-0"]).toMatchObject({
    customAnswer: "second try",
  });
  expect(toast).toHaveBeenCalledTimes(1);
});

function QuestionPositionProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  return (
    <>
      <output>Question {state.activePendingQuestionIndex + 1}</output>
      <button
        type="button"
        onClick={() => state.onSelectActivePendingUserInputOption("question-0", "Incremental")}
      >
        Choose Incremental
      </button>
      <button type="button" onClick={() => state.onAdvanceActivePendingUserInput()}>
        Submit
      </button>
    </>
  );
}

it("stays on an unanswered question when the composer submits", async () => {
  await using screen = await render(
    <QuestionPositionProbe
      environmentId={EnvironmentId.make("unanswered-environment")}
      projection={questionProjection(threadRef.threadId)}
    />,
  );
  const submit = screen.getByRole("button", { name: "Submit" });
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 1");

  await userEvent.click(screen.getByRole("button", { name: "Choose Incremental" }));
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 2");
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

  // "first" was answered on another device.
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
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadRef.threadId,
    )([RuntimeRequestId.make("second")]),
  );
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});
