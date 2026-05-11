import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@forma/contracts";
import { describe, expect, it } from "vitest";

import { canPromoteQueuedTurnAfterLifecycleBarrier } from "./turnQueue.ts";

const NOW = "2026-03-02T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const QUEUED_MESSAGE_ID = MessageId.make("queued-1");
const TURN_ID = TurnId.make("turn-1");

function makeThread(
  overrides: Partial<
    Pick<OrchestrationThread, "session" | "turnQueue" | "latestTurn" | "messages">
  > = {},
): Pick<OrchestrationThread, "session" | "turnQueue" | "latestTurn" | "messages"> {
  return {
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    turnQueue: {
      items: [
        {
          messageId: QUEUED_MESSAGE_ID,
          text: "queued",
          attachmentIds: [],
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          titleSeed: null,
          sourceProposedPlan: null,
          queuedAt: NOW,
        },
      ],
      status: "queued",
      pauseReason: null,
    },
    latestTurn: null,
    messages: [],
    ...overrides,
  };
}

const latestTurn = (
  state: "running" | "completed" | "error" | "interrupted",
  completedAt: string | null,
) => ({
  turnId: TURN_ID,
  state,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt,
  assistantMessageId: null,
});

describe("canPromoteQueuedTurnAfterLifecycleBarrier", () => {
  it("allows queued-only idle threads with no latest turn", () => {
    expect(canPromoteQueuedTurnAfterLifecycleBarrier(makeThread())).toBe(true);
  });

  it("allows terminal latest turns with completion timestamps", () => {
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({ latestTurn: latestTurn("completed", NOW) }),
      ),
    ).toBe(true);
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({ latestTurn: latestTurn("error", NOW) }),
      ),
    ).toBe(true);
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({ latestTurn: latestTurn("interrupted", NOW) }),
      ),
    ).toBe(true);
  });

  it("blocks running or incomplete latest turns", () => {
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({ latestTurn: latestTurn("running", null) }),
      ),
    ).toBe(false);
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({ latestTurn: latestTurn("completed", null) }),
      ),
    ).toBe(false);
  });

  it("blocks ambiguous accepted-message state without a latest turn", () => {
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({
          messages: [
            {
              id: MessageId.make("message-accepted"),
              role: "user",
              text: "accepted",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("blocks busy or paused queues", () => {
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TURN_ID,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe(false);
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({
          session: {
            threadId: THREAD_ID,
            status: "starting",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe(false);
    expect(
      canPromoteQueuedTurnAfterLifecycleBarrier(
        makeThread({
          turnQueue: {
            items: makeThread().turnQueue.items,
            status: "paused",
            pauseReason: "error",
          },
        }),
      ),
    ).toBe(false);
  });
});
