import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

const state = vi.hoisted(() => ({
  visibleTurnItems: [] as ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useTimelineVisibleTurnItems: (() => state.visibleTurnItems) as never,
}));

import { render } from "../../../test/render";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { peekRememberedThreadTimeline, resetHeldThreadTimeline } from "../ChatView.logic";
import { SideChatTimeline } from "./SideChatTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LESSON_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("lesson-1"));

function setup() {
  resetHeldThreadTimeline();
  state.visibleTurnItems = [];
}

function timelineProps(
  fixture: ReturnType<typeof makeStreamingTimelineFixture>,
  key: string = fixture.threadId,
) {
  const sideChatRef = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(`side-chat-${key}`));
  return {
    lessonRef: LESSON_REF,
    sideChatRef,
    detailRef: sideChatRef,
    projection: null,
    label: "Box",
    detailLoading: false,
    optimisticMessages: [],
    listRef: createRef<LegendListRef | null>(),
    citationRequest: null,
    askInSideChatPending: false,
    onCiteAssistantText: () => true,
    onAskInSideChat: () => true,
    onOpenThread: () => {},
    workspaceRoot: undefined,
    pendingApprovals: [],
    respondingRequestIds: [],
    canOperate: true,
    onRespondToApproval: async () => {},
  } satisfies ComponentProps<typeof SideChatTimeline>;
}

function optimisticMessage(id: string) {
  return {
    id: MessageId.make(id),
    role: "user" as const,
    text: "Follow up",
    runId: null,
    streaming: false,
    createdAt: "2026-09-04T00:00:08.000Z",
    updatedAt: "2026-09-04T00:00:08.000Z",
  };
}

function timelineContainer() {
  const container = document.createElement("div");
  container.style.cssText = "height: 480px; width: 800px; display: flex; flex-direction: column;";
  return container;
}

it("shows the side chat's replies without entering the remembered-timeline cache", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A Box is a bounded space of numbers.");
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture, "cache");
  const sideChatRef = props.sideChatRef;

  await using screen = await render(<SideChatTimeline {...props} />, {
    container: timelineContainer(),
  });

  await expect.element(screen.getByText("A Box is a bounded space of numbers.")).toBeVisible();
  expect(peekRememberedThreadTimeline(scopedThreadKey(sideChatRef))).toBeNull();
});

it("offers no fork on a side chat's finished reply", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("Still streaming");
  state.visibleTurnItems = fixture.visibleTurnItems;

  await using screen = await render(<SideChatTimeline {...timelineProps(fixture, "finished")} />, {
    container: timelineContainer(),
  });

  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Copy message" }).first())
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Fork from this response" }))
    .not.toBeInTheDocument();
});

it("keeps a reader's position while a side chat reply streams", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A long reply. ".repeat(800));
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture);
  const container = timelineContainer();

  await using screen = await render(<SideChatTimeline {...props} />, { container });
  const scroll = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await expect.element(screen.getByText("A long reply.", { exact: false })).toBeVisible();
  await vi.waitFor(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));

  const node = scroll();
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
  node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 300);
  node.dispatchEvent(new Event("scroll"));
  const heldPosition = node.scrollTop;
  await expect.element(screen.getByRole("button", { name: /scroll to end/i })).toBeVisible();

  state.visibleTurnItems = fixture.visibleTurnItems.map((row) =>
    row.item.type === "assistant_message"
      ? {
          ...row,
          item: {
            ...row.item,
            text: `${row.item.text}\nMore output. ${"still writing. ".repeat(200)}`,
          },
        }
      : row,
  );
  expect(state.visibleTurnItems).not.toBe(fixture.visibleTurnItems);
  await screen.rerender(<SideChatTimeline {...props} />);
  // The expanding streaming row may preserve its visible anchor as it grows; it must not
  // collapse the reader's 300px gap to the live end.
  expect(node.scrollTop).toBeGreaterThanOrEqual(heldPosition);
  expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeGreaterThan(100);

  await screen.getByRole("button", { name: /scroll to end/i }).click();
  await vi.waitFor(() =>
    expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2),
  );
});

it("scrolls a far reader to the end when this side chat sends", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A long reply. ".repeat(800));
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture, "own-send");
  const container = timelineContainer();

  await using screen = await render(<SideChatTimeline {...props} />, { container });
  const scroll = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await vi.waitFor(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));
  const node = scroll();
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
  node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight * 2 - 200);
  node.dispatchEvent(new Event("scroll"));
  await expect.element(screen.getByRole("button", { name: /scroll to end/i })).toBeVisible();

  await screen.rerender(
    <SideChatTimeline {...props} optimisticMessages={[optimisticMessage("own-send-1")]} />,
  );
  await vi.waitFor(() =>
    expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2),
  );
  await expect
    .element(screen.getByRole("button", { name: /scroll to end/i }))
    .not.toBeInTheDocument();
});

it("ignores document key navigation while the side chat is following", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A long reply. ".repeat(800));
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture, "body-key");
  const container = timelineContainer();

  await using screen = await render(<SideChatTimeline {...props} />, { container });
  const node = container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await vi.waitFor(() =>
    expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2),
  );
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  state.visibleTurnItems = fixture.visibleTurnItems.map((row) =>
    row.item.type === "assistant_message"
      ? { ...row, item: { ...row.item, text: `${row.item.text}\nMore output.` } }
      : row,
  );
  await screen.rerender(<SideChatTimeline {...props} />);

  await vi.waitFor(() =>
    expect(node.scrollHeight - node.scrollTop - node.clientHeight).toBeLessThan(2),
  );
  await expect
    .element(screen.getByRole("button", { name: /scroll to end/i }))
    .not.toBeInTheDocument();
});

it("restores a released position and the scroll-to-end affordance on remount", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A long reply. ".repeat(800));
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture, "remount-history");
  const container = timelineContainer();

  await using screen = await render(<SideChatTimeline key="first" {...props} />, { container });
  const first = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await vi.waitFor(() => expect(first().scrollHeight).toBeGreaterThan(first().clientHeight));
  first().dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
  first().scrollTop = Math.max(0, first().scrollHeight - first().clientHeight - 300);
  first().dispatchEvent(new Event("scroll"));
  await expect.element(screen.getByRole("button", { name: /scroll to end/i })).toBeVisible();

  await screen.rerender(<SideChatTimeline key="second" {...props} />);
  const second = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await vi.waitFor(() =>
    expect(second().scrollHeight - second().scrollTop - second().clientHeight).toBeGreaterThan(100),
  );
  await expect.element(screen.getByRole("button", { name: /scroll to end/i })).toBeVisible();
});

it("keeps following when a side chat remounts at its end", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture("A long reply. ".repeat(800));
  state.visibleTurnItems = fixture.visibleTurnItems;
  const props = timelineProps(fixture, "remount-end");
  const container = timelineContainer();

  await using screen = await render(<SideChatTimeline key="first" {...props} />, { container });
  const scroll = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  await vi.waitFor(() =>
    expect(scroll().scrollHeight - scroll().scrollTop - scroll().clientHeight).toBeLessThan(2),
  );
  await screen.rerender(<SideChatTimeline key="second" {...props} />);
  await vi.waitFor(() =>
    expect(scroll().scrollHeight - scroll().scrollTop - scroll().clientHeight).toBeLessThan(2),
  );
  await expect
    .element(screen.getByRole("button", { name: /scroll to end/i }))
    .not.toBeInTheDocument();
});
