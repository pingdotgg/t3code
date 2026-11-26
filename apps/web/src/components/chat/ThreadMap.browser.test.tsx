import "~/index.css";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ texts: {} as Record<string, string> }));

vi.mock(import("../../state/entities"), () => ({
  useAssistantMessageText: ((_ref: unknown, itemId: string | undefined) =>
    itemId === undefined ? null : (state.texts[itemId] ?? null)) as never,
  useQuietThreadShell: (() => null) as never,
  useThreadShell: (() => null) as never,
  useProject: (() => null) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useThreadMapViewStore } from "../../threadMapViewStore";
import ThreadMap from "./ThreadMap";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread-test"));
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, second));

function fixture(): OrchestrationV2ThreadProjection {
  const base = makeThreadProjectionFixture();
  const run = (ordinal: number) => ({
    id: RunId.make(`run-${ordinal}`),
    threadId: threadRef.threadId,
    ordinal,
    providerInstanceId: base.thread.providerInstanceId,
    modelSelection: base.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`prompt-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: at(ordinal * 10),
    startedAt: at(ordinal * 10),
    completedAt: at(ordinal * 10 + 4),
    checkpointId: null,
    contextHandoffId: null,
  });
  const item = (id: string, ordinal: number) => ({
    id: TurnItemId.make(id),
    threadId: threadRef.threadId,
    runId: RunId.make(`run-${ordinal}`),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at(0),
    completedAt: at(0),
    updatedAt: at(0),
  });
  const items: OrchestrationV2TurnItem[] = [
    {
      ...item("prompt-1-item", 1),
      type: "user_message",
      messageId: MessageId.make("prompt-1"),
      inputIntent: "turn_start",
      text: "Fix the build\nIt fails on CI",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...item("answer-1", 1),
      type: "assistant_message",
      messageId: MessageId.make("answer-1"),
      phase: "final_answer",
      text: "",
      streaming: false,
    },
    {
      ...item("prompt-2-item", 2),
      type: "user_message",
      messageId: MessageId.make("prompt-2"),
      inputIntent: "turn_start",
      text: "Review the reviewer's notes",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...item("send-2", 2),
      type: "dynamic_tool",
      toolName: "t3_thread_send",
      input: { threadId: "helper-thread", message: "Can you check the notes?" },
    },
  ];
  return {
    ...base,
    runs: [run(1), run(2)],
    subagents: [
      {
        id: NodeId.make("reviewer"),
        threadId: threadRef.threadId,
        runId: RunId.make("run-1"),
        parentNodeId: NodeId.make("root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: base.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("reviewer-thread"),
        nativeTaskRef: null,
        prompt: "Review the fix",
        title: "Reviewer",
        model: null,
        status: "completed",
        completionDelivery: { state: "acknowledged", observedByRunId: RunId.make("run-2") },
        result: "Looks right.",
        startedAt: null,
        completedAt: null,
        updatedAt: at(0),
      },
    ],
    turnItems: items,
    visibleTurnItems: items.map((entry, position) => ({
      position,
      visibility: "local",
      sourceThreadId: threadRef.threadId,
      sourceItemId: entry.id,
      item: entry,
    })),
  };
}

function setup() {
  state.texts = { "answer-1": "The build passes again." };
  useThreadMapViewStore.setState({ mapThreadKeys: new Set([scopedThreadKey(threadRef)]) });
}

it("shows the selected turn and agent below the map and returns to the turn's message", async () => {
  setup();
  await using screen = await render(
    <div className="flex h-[640px] w-[960px] flex-col">
      <ThreadMap threadRef={threadRef} projection={fixture()} bottomInset={0} />
    </div>,
  );
  const details = screen.getByRole("group", { name: "Details" });

  await screen.getByRole("button", { name: /^Reviewer,/ }).click();
  await expect.element(details.getByText("Looks right.")).toBeVisible();
  await expect.element(details.getByText(/came back into turn 2/)).toBeVisible();
  await expect.element(details.getByRole("button", { name: "Open thread" })).toBeVisible();

  await screen.getByRole("button", { name: /^Turn 1, Prompt, Fix the build/ }).click();
  await expect.element(details.getByText("The build passes again.")).toBeVisible();
  await details.getByRole("button", { name: "Show in conversation" }).click();

  expect(readTimelinePosition(scopedThreadKey(threadRef))).toMatchObject({
    rowId: "prompt-1",
    atEnd: false,
  });
  expect(useThreadMapViewStore.getState().mapThreadKeys.size).toBe(0);
});
it("opens the thread a turn sent a message to", async () => {
  setup();
  await using screen = await render(
    <div className="flex h-[640px] w-[960px] flex-col">
      <ThreadMap threadRef={threadRef} projection={fixture()} bottomInset={0} />
    </div>,
  );
  const target = "/environment/helper-thread";
  const card = screen.getByRole("link", { name: /^Sent a message/ });
  await expect.element(card).toHaveAttribute("href", target);

  await screen.getByRole("button", { name: /^Turn 2,/ }).click();
  const details = screen.getByRole("group", { name: "Details" });
  await expect
    .element(details.getByRole("link", { name: "Thread, Another thread" }))
    .toHaveAttribute("href", target);

  await card.click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe(target));
});
it("lets the turn shown in the conversation take over from a citation already followed", async () => {
  setup();
  await using screen = await render(
    <div className="flex h-[640px] w-[960px] flex-col">
      <ThreadMap threadRef={threadRef} projection={fixture()} bottomInset={0} />
    </div>,
    { router: "/thread#assistant-citation=cited" },
  );
  const details = screen.getByRole("group", { name: "Details" });

  await screen.getByRole("button", { name: /^Turn 1, Prompt, Fix the build/ }).click();
  await details.getByRole("button", { name: "Show in conversation" }).click();

  await vi.waitFor(() => expect(useThreadMapViewStore.getState().mapThreadKeys.size).toBe(0));
  expect(screen.router?.state.location.href).toBe("/thread");
});

it("fits the whole map when the opening view shows only the newest turns", async () => {
  setup();
  useThreadMapViewStore.setState({ mapThreadKeys: new Set() });
  await using screen = await render(
    <div className="flex h-[300px] w-[960px] flex-col">
      <ThreadMap threadRef={threadRef} projection={fixture()} bottomInset={0} />
    </div>,
  );
  const fitButton = screen.getByRole("button", { name: "Fit the map to view" });
  const firstTurn = screen.getByRole("button", { name: /^Turn 1, Prompt/ });
  await expect.element(firstTurn).toBeInTheDocument();
  const inCanvas = () => {
    const card = firstTurn.element();
    // The scene is the transformed layer; the canvas that clips it is its parent.
    const canvas = card.closest<HTMLElement>('[style*="scale("]')!.parentElement!;
    const bounds = canvas.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  };

  await expect.element(fitButton).toBeEnabled();
  expect(inCanvas()).toBe(false);
  await fitButton.click();
  await expect.element(fitButton).toBeDisabled();
  await vi.waitFor(() => expect(inCanvas()).toBe(true));
});

it("opens a turn that starts before the loaded history at the top of the conversation", async () => {
  setup();
  const projection = fixture();
  // The window starts inside turn 1: its prompt row is not loaded.
  const visibleTurnItems = projection.visibleTurnItems.filter(
    (entry) => entry.item.id !== "prompt-1-item",
  );
  // The reader had scrolled down the conversation before opening the map.
  rememberTimelinePosition(
    scopedThreadKey(threadRef),
    { rowId: "answer-1", offsetWithinRow: 0, scrollOffset: 900, atEnd: false },
    false,
  );
  await using screen = await render(
    <div className="flex h-[640px] w-[960px] flex-col">
      <ThreadMap
        threadRef={threadRef}
        projection={{ ...projection, visibleTurnItems }}
        bottomInset={0}
      />
    </div>,
  );
  const details = screen.getByRole("group", { name: "Details" });

  await screen.getByRole("button", { name: /^Turn 1,/ }).click();
  await details.getByRole("button", { name: "Show in conversation" }).click();

  expect(readTimelinePosition(scopedThreadKey(threadRef))).toMatchObject({
    scrollOffset: 0,
    atEnd: false,
  });
});
