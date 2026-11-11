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

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import {
  ComposerPendingUserInputPanel,
  type PendingQuestionKeyHandler,
} from "./ComposerPendingUserInputPanel";
import { useChatShortcuts } from "./useChatShortcuts";
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

function questionProjection(
  threadId: ThreadId,
  requestIds = ["first", "second"],
  questions: ReadonlyArray<(typeof prompt.questions)[number] | ReleaseQuestion> = prompt.questions,
) {
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
      questions: [...questions],
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  draftTarget?: DraftId;
}

function useProbeRequests({ environmentId, projection, loading = false, draftTarget }: ProbeProps) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  return usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: draftTarget ?? { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
}

let requests: ReturnType<typeof usePendingThreadRequests>;

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
  const probe = (threadId: ThreadId) => (
    <PendingRequestsProbe environmentId={environmentId} projection={questionProjection(threadId)} />
  );
  await using screen = await render(probe(threadRef.threadId));

  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  // An option number is a pick, not typed text, so a click does not set it aside.
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "1"));
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

  // The hook outlives a thread switch; text set aside in another thread is in another draft.
  await screen.rerender(probe(ThreadId.make("other-thread")));
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "elsewhere"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  await screen.rerender(probe(threadRef.threadId));

  // regression: #35205 undo puts the set-aside text back, so the draft must not keep a copy to resend
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "first try"));
  expect(draftPrompt() ?? "").toBe("");

  // Text set aside into a queued-message edit draft never withdraws from the thread draft.
  await screen.rerender(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={questionProjection(threadRef.threadId)}
      draftTarget={DraftId.make("queued-edit")}
    />,
  );
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "foo"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  await screen.rerender(probe(threadRef.threadId));
  useComposerDraftStore.getState().setPrompt(draftTarget, "foo");
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "foo"));
  expect(draftPrompt()).toBe("foo");
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
    )([
      { id: RuntimeRequestId.make("first"), status: "resolved" },
      { id: RuntimeRequestId.make("second"), status: "pending" },
    ]),
  );
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

interface ReleaseQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}
const steps: ReleaseQuestion = {
  id: "steps",
  header: "Release go",
  question: "Which steps may I take now?",
  options: [
    { label: "Push", description: "Push the merge commit" },
    { label: "Merge", description: "Merge once green" },
    { label: "Open PR", description: "Docs only" },
  ],
  multiSelect: true,
};
const channel: ReleaseQuestion = {
  id: "channel",
  header: "Channel",
  question: "Which channel gets it first?",
  options: [
    { label: "Beta", description: "Testers" },
    { label: "Stable", description: "Everyone" },
  ],
  multiSelect: false,
};

/** The chat's real shortcuts, requests and question panel, beside an answer field. */
function KeyboardChat(
  props: ProbeProps & {
    onConfirm: () => void;
    onAdvance: () => void;
    insertTextAtEnd: ChatComposerHandle["insertTextAtEnd"];
  },
) {
  const state = useProbeRequests(props);
  useLayoutEffect(() => {
    requests = state;
  });
  const keyHandlerRef = useRef<PendingQuestionKeyHandler | null>(null);
  const composer: Pick<ChatComposerHandle, "handlePendingQuestionKey" | "insertTextAtEnd"> = {
    handlePendingQuestionKey: (event, target) => keyHandlerRef.current?.(event, target) ?? false,
    insertTextAtEnd: props.insertTextAtEnd,
  };
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: { current: composer as ChatComposerHandle },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return (
    <>
      <div data-testid="composer-editor" contentEditable suppressContentEditableWarning>
        {state.activePendingProgress?.customAnswer}
      </div>
      <div data-chat-composer-top-drawer="true">
        <ComposerPendingUserInputPanel
          pendingUserInputs={state.pendingUserInputs}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={state.activePendingDraftAnswers}
          questionIndex={state.activePendingQuestionIndex}
          keyHandlerRef={keyHandlerRef}
          onToggleOption={state.onSelectActivePendingUserInputOption}
          // ChatComposer types the number into the answer the same way.
          onOptionKey={(questionId, key) =>
            state.onChangeActivePendingUserInputCustomAnswer(questionId, key)
          }
          onRemoveOptionKey={state.onRemoveActivePendingUserInputOptionKey}
          onAdvance={props.onAdvance}
          onConfirm={props.onConfirm}
          onDismiss={() => {}}
        />
      </div>
    </>
  );
}

async function renderKeyboardChat(name: string, questions: ReleaseQuestion[]) {
  const onConfirm = vi.fn();
  const onAdvance = vi.fn();
  const insertTextAtEnd = vi.fn(() => true);
  const screen = await render(
    <KeyboardChat
      environmentId={EnvironmentId.make(`${name}-environment`)}
      projection={questionProjection(threadRef.threadId, [name], questions)}
      onConfirm={onConfirm}
      onAdvance={onAdvance}
      insertTextAtEnd={insertTextAtEnd}
    />,
  );
  const option = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
  return { screen, option, onConfirm, onAdvance, insertTextAtEnd };
}

it("picks options with numbers typed into the empty answer field until other text follows", async () => {
  const { screen, option } = await renderKeyboardChat("keys", [steps]);
  await using _ = screen;
  const answerField = screen.getByTestId("composer-editor");
  (answerField.element() as HTMLElement).focus();

  await userEvent.keyboard("132");
  for (const label of ["Push", "Merge", "Open PR"]) {
    await expect.element(option(label)).toHaveAttribute("aria-pressed", "true");
  }
  expect(answerField.element().textContent).toBe("");

  await userEvent.keyboard("{Backspace}");
  await expect.element(option("Merge")).toHaveAttribute("aria-pressed", "false");

  // The composer hands on the field's new text: a space after the hidden numbers.
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("steps", " "));
  expect(answerField.element().textContent).toBe("13 ");
  for (const label of ["Push", "Merge", "Open PR"]) {
    await expect.element(option(label)).toHaveAttribute("aria-pressed", "false");
  }
});

it("waits for Enter after a number picks a single choice with nothing focused", async () => {
  const { screen, option, onConfirm, onAdvance, insertTextAtEnd } = await renderKeyboardChat(
    "single",
    [channel, steps],
  );
  await using _ = screen;
  using _timers = fakeTimers();

  await userEvent.keyboard("2");
  // A click would advance after 200 ms; a key waits for Enter.
  await act(() => vi.advanceTimersByTime(1000));
  expect(option("Stable").element()).toHaveAttribute("aria-pressed", "true");
  expect(onAdvance).not.toHaveBeenCalled();
  expect(insertTextAtEnd).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("confirms on Enter after a click instead of unselecting the clicked option", async () => {
  const { screen, option, onConfirm } = await renderKeyboardChat("click", [steps]);
  await using _ = screen;

  // Reading the question first leaves focus on its card, not on a control.
  await screen.getByText("Which steps may I take now?").click();
  await option("Merge").click();
  await userEvent.keyboard("{Enter}");

  await expect.element(option("Merge")).toHaveAttribute("aria-pressed", "true");
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
