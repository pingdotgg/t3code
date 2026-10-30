import "~/index.css";
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

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), mathRenderingEnabled: true };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import { page, userEvent } from "vite-plus/test/browser";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { act, fakeTimers, render } from "../../../test/render";
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
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
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

function markdownPanel(
  onToggleOption = vi.fn(),
  onAdvance = vi.fn(),
  option = {
    label: "**Return** Promise<void>",
    description: "Use [help](https://example.com/help) with Array<string>.",
  },
) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          ...prompt,
          questions: [
            {
              ...prompt.questions[0]!,
              question: "Schema\n\nRead **the guide** and Promise<void>.",
              options: [option],
            },
          ],
        },
      ]}
      cwd="/repo"
      threadRef={threadRef}
      answers={{}}
      questionIndex={0}
      respondingRequestIds={[]}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={() => {}}
    />
  );
}

it("renders option Markdown while preserving the raw answer", async () => {
  using _timers = fakeTimers();
  const select = vi.fn();
  const advance = vi.fn();
  await using screen = await render(markdownPanel(select, advance));
  await expect.element(screen.getByText("Return", { exact: true })).toBeVisible();
  expect(screen.container.innerText).toContain("Return Promise<void>");
  expect(screen.container.innerText).toContain("with Array<string>.");
  await userEvent.click(screen.getByRole("button", { name: "Return Promise<void>", exact: true }));
  expect(select).toHaveBeenCalledExactlyOnceWith("question-0", "**Return** Promise<void>");
  await act(() => vi.advanceTimersByTime(200));
  expect(advance).toHaveBeenCalledOnce();
});

it("opens option links without answering or advancing", async () => {
  using _timers = fakeTimers();
  const select = vi.fn();
  const advance = vi.fn();
  await using screen = await render(markdownPanel(select, advance));
  const link = screen.getByRole("link", { name: "help", exact: true });
  const opened = vi.fn((event: Event) => event.preventDefault());
  link.element().addEventListener("click", opened);
  await userEvent.click(link);
  (link.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(opened).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTime(200));
  expect(select).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});

it("renders an inert collapsed Markdown preview", async () => {
  await using screen = await render(markdownPanel());
  await userEvent.click(
    screen.container.querySelector<HTMLButtonElement>("[data-pending-user-input-toggle]")!,
  );
  await expect
    .element(screen.getByRole("button", { name: "Return Promise<void>", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("the guide", { exact: true })).toBeVisible();
  expect(screen.container.innerText).toContain("Promise<void>.");
  expect(screen.container.innerText).not.toContain("**");
});

it("opens option images without answering", async () => {
  const select = vi.fn();
  const advance = vi.fn();
  const image = new URL("/apple-touch-icon.png", window.location.href).href;
  await using screen = await render(
    markdownPanel(select, advance, { label: `![Preview](${image})`, description: "" }),
  );
  await userEvent.click(screen.getByAltText("Preview", { exact: true }));
  await expect.element(page.getByRole("dialog", { name: "Expanded image preview" })).toBeVisible();
  expect(select).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});

it("scrolls option equations without answering", async () => {
  const select = vi.fn();
  const advance = vi.fn();
  const container = document.createElement("div");
  container.style.width = "400px";
  await using screen = await render(
    markdownPanel(select, advance, {
      label: "Equation",
      description: "$$\n" + Array(100).fill("x_i").join(" + ") + "\n$$",
    }),
    { container },
  );
  const scroller = screen.getByLabelText("Scroll display equation");
  await expect.element(scroller).toBeVisible();
  const element = scroller.element();
  await vi.waitFor(() => expect(element.scrollWidth).toBeGreaterThan(element.clientWidth));
  await userEvent.click(scroller);
  await userEvent.wheel(element, { delta: { x: 200, y: 0 } });
  await vi.waitFor(() => expect(element.scrollLeft).toBeGreaterThan(0));
  expect(select).not.toHaveBeenCalled();
  expect(advance).not.toHaveBeenCalled();
});
