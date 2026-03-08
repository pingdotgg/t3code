import "../index.css";

import type { NativeApi, OrchestrationEvent } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EventsRoutePage } from "./_chat.events";

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

describe("events lifecycle route", () => {
  beforeEach(() => {
    callbackRef.current = null;
  });

  it("filters by trace and appends live events", async () => {
    const screen = await render(<EventsRoutePage />);

    await expect.element(page.getByText("Event trace playground")).toBeInTheDocument();
    await expect.element(page.getByText("3 events rendered")).toBeInTheDocument();

    await page.getByRole("button", { name: "Turn lifecycle (request → diff)" }).click();
    await expect.element(page.getByText("2 events rendered")).toBeInTheDocument();

    callbackRef.current?.(makeEvent(4, "thread.activity-appended"));
    await expect.element(page.getByText("3 events rendered")).toBeInTheDocument();

    await screen.unmount();
  });
});

function makeEvent(sequence: number, type: OrchestrationEvent["type"]): OrchestrationEvent {
  const base = {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
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
          threadId: "thread-1",
          messageId: "message-1",
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
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
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
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1",
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
          threadId: "thread-1",
          activity: {
            id: "event-activity-1",
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
