import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const defaultPrompt: PendingUserInput = {
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

function Questions({ prompt }: { prompt: PendingUserInput }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  return (
    <>
      <output>{questionIndex}</output>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={() => setQuestionIndex(questionIndex + 1)}
        onToggleOption={(questionId, value) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

function optionKeys(container: HTMLElement) {
  return [...container.querySelectorAll("button[aria-pressed]")].map((button) => {
    const key = button.querySelector("[data-pending-user-input-option-key]")!;
    return {
      pressed: button.getAttribute("aria-pressed"),
      key: key.querySelector("svg") ? "check" : key.textContent,
    };
  });
}

function pressKey(key: string) {
  return act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

it("swaps the chosen option's number for a check in place and restores it when the choice moves", async () => {
  const options = [
    { label: "Rolling", description: "One node at a time" },
    { label: "Canary", description: "A slice of traffic first" },
    { label: "Big bang", description: "Everything at once" },
  ];
  const choicePrompt = {
    ...defaultPrompt,
    questions: [
      { ...defaultPrompt.questions[0]!, options },
      { ...defaultPrompt.questions[1]!, options, multiSelect: true },
    ],
  };
  await using screen = await render(<Questions prompt={choicePrompt} />);
  using _timers = fakeTimers();
  const keys = () => optionKeys(screen.container);
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  const unpressed = [
    { pressed: "false", key: "1" },
    { pressed: "false", key: "2" },
    { pressed: "false", key: "3" },
  ];
  expect(keys()).toEqual(unpressed);

  await pressKey("2");
  expect(keys()).toEqual([
    { pressed: "false", key: "1" },
    { pressed: "true", key: "check" },
    { pressed: "false", key: "3" },
  ]);

  await pressKey("1");
  expect(keys()).toEqual([
    { pressed: "true", key: "check" },
    { pressed: "false", key: "2" },
    { pressed: "false", key: "3" },
  ]);

  await act(() => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
  expect(keys()).toEqual(unpressed);
  await pressKey("1");
  await pressKey("3");
  expect(keys()).toEqual([
    { pressed: "true", key: "check" },
    { pressed: "false", key: "2" },
    { pressed: "true", key: "check" },
  ]);
  await pressKey("1");
  expect(keys()).toEqual([
    { pressed: "false", key: "1" },
    { pressed: "false", key: "2" },
    { pressed: "true", key: "check" },
  ]);
  await act(() => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it("does not select or advance from a custom-answer hint", async () => {
  const prompt: PendingUserInput = {
    ...defaultPrompt,
    questions: [
      {
        ...defaultPrompt.questions[0]!,
        options: [
          { label: "Rolling", description: "One node at a time" },
          { label: "Canary", description: "A slice of traffic first" },
          {
            label: "Write my own answer",
            description: "Write my own answer",
            customAnswer: true,
          },
        ],
      },
    ],
  };
  await using screen = await render(<Questions prompt={prompt} />);
  using _timers = fakeTimers();
  const keys = () => optionKeys(screen.container);
  const activeIndex = () => screen.container.querySelector("output")!.textContent;
  const unpressed = [
    { pressed: "false", key: "1" },
    { pressed: "false", key: "2" },
  ];
  expect(keys()).toEqual(unpressed);

  const customAnswer = screen.container.querySelector<HTMLElement>(
    "[data-pending-user-input-custom-answer-option]",
  )!;
  expect(customAnswer.tagName).toBe("DIV");
  await act(() => customAnswer.click());
  await pressKey("3");
  await act(() => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
  expect(keys()).toEqual(unpressed);

  await pressKey("2");
  expect(keys()).toEqual([
    { pressed: "false", key: "1" },
    { pressed: "true", key: "check" },
  ]);
});

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
      questions: defaultPrompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

let requests: ReturnType<typeof usePendingThreadRequests>;

function PendingRequestsProbe({
  environmentId,
  projection,
  loading = false,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
}) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    activeThread: projection.thread,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
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
