import "../index.css";

import type { NativeApi, OrchestrationEvent } from "@t3tools/contracts";
import { CheckpointRef, EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EventsRoutePage } from "./_chat.$threadId.events";

const callbackRef: { current: ((event: OrchestrationEvent) => void) | null } = { current: null };

const replayedEvents: ReadonlyArray<OrchestrationEvent> = [
  makeEvent(1, "thread.turn-start-requested"),
  makeEvent(2, "thread.session-set"),
  makeEvent(3, "thread.turn-diff-completed"),
];

vi.mock("../nativeApi", () => ({
  readNativeApi: () =>
    ({
      orchestration: {
        replayEvents: vi.fn(async () => replayedEvents),
        onDomainEvent: (callback: (event: OrchestrationEvent) => void) => {
          callbackRef.current = callback;
          return () => {
            callbackRef.current = null;
          };
        },
      },
    }) as unknown as NativeApi,
}));

const { searchRef } = vi.hoisted(() => {
  const searchRef: {
    current: { event?: number };
    update: ((s: { event?: number }) => void) | null;
  } = { current: {}, update: null };
  return { searchRef };
});

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    createFileRoute: () => () => ({
      useParams: ({ select }: { select: (p: { threadId: string }) => unknown }) => select({ threadId: "thread-1" }),
      useSearch: ({ select }: { select: (s: { event?: number }) => unknown }) => {
        const [search, setSearch] = React.useState(searchRef.current);
        searchRef.update = (s) => {
          searchRef.current = s;
          setSearch(s);
        };
        return select(search);
      },
    }),
    useNavigate:
      () =>
      (opts: { search?: { event?: number } }) => {
        searchRef.update?.(opts?.search ?? {});
        return Promise.resolve();
      },
  };
});

describe("events lifecycle route", () => {
  beforeEach(() => {
    callbackRef.current = null;
    searchRef.current = {};
    searchRef.update = null;
  });

  it("filters by trace and appends live events", async () => {
    const screen = await render(<EventsRoutePage />);

    await expect.element(page.getByText("3 events")).toBeInTheDocument();

    // Filter by trace using the select dropdown
    const traceSelect = page.getByTestId("trace-selector");
    const selectEl = traceSelect.element() as HTMLSelectElement;
    selectEl.value = "turn-lifecycle";
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByText("2 events")).toBeInTheDocument();

    callbackRef.current?.(makeEvent(4, "thread.activity-appended"));
    await expect.element(page.getByText("3 events")).toBeInTheDocument();

    await screen.unmount();
  });

  it("shows event detail panel when clicking an event card", async () => {
    const screen = await render(<EventsRoutePage />);

    await expect.element(page.getByText("3 events")).toBeInTheDocument();

    // Click the first event row
    await page.getByRole("cell", { name: "turn-start-requested" }).click();

    // Detail panel should appear with payload content
    await expect.element(page.getByTestId("event-detail")).toBeInTheDocument();
    await expect.element(page.getByTestId("event-payload")).toBeInTheDocument();

    await screen.unmount();
  });

  it("closes detail panel and returns trace guide", async () => {
    const screen = await render(<EventsRoutePage />);

    await expect.element(page.getByText("3 events")).toBeInTheDocument();

    // Click an event to open detail
    await page.getByRole("cell", { name: "turn-start-requested" }).click();
    await expect.element(page.getByTestId("event-detail")).toBeInTheDocument();

    // Trace guide should not be visible
    await expect.element(page.getByTestId("trace-details")).not.toBeInTheDocument();

    // Close the detail panel
    await page.getByTestId("close-detail").click();

    // Trace guide should return
    await expect.element(page.getByTestId("trace-details")).toBeInTheDocument();
    await expect.element(page.getByTestId("event-detail")).not.toBeInTheDocument();

    await screen.unmount();
  });
});

function makeEvent(sequence: number, type: OrchestrationEvent["type"]): OrchestrationEvent {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const base = {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-03-07T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as const;

  switch (type) {
    case "thread.turn-start-requested":
      return {
        ...base,
        type,
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-1"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-03-07T00:00:00.000Z",
        },
      };
    case "thread.session-set":
      return {
        ...base,
        type,
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-03-07T00:00:00.000Z",
          },
        },
      };
    case "thread.turn-diff-completed":
      return {
        ...base,
        type,
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-03-07T00:00:00.000Z",
        },
      };
    case "thread.activity-appended":
      return {
        ...base,
        type,
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("event-activity-1"),
            tone: "tool",
            kind: "tool.call",
            summary: "Ran tool",
            payload: {},
            turnId: null,
            sequence,
            createdAt: "2026-03-07T00:00:00.000Z",
          },
        },
      };
    default:
      throw new Error(`Unsupported event type in test fixture: ${type}`);
  }
}
