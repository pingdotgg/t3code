import {
  EventId,
  ThreadHandoffId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { findThreadHandoff } from "./threadHandoff.ts";

const NOW = "2026-08-18T12:00:00.000Z";
const HANDOFF_ID = ThreadHandoffId.make("handoff-1");
const TURN_ID = TurnId.make("turn-1");

describe("findThreadHandoff", () => {
  it("folds same-timestamp request and availability activities for client handoff cards", () => {
    const thread: Pick<OrchestrationThread, "id" | "activities"> = {
      id: ThreadId.make("source"),
      activities: [
        {
          id: EventId.make("requested"),
          tone: "info",
          kind: "thread-handoff.requested",
          summary: "Thread handoff requested",
          payload: {
            handoffId: HANDOFF_ID,
            requestingTurnId: TURN_ID,
            title: "Implementation",
            prompt: "Implement the approved plan.",
            artifactReferences: [],
            requestedAt: NOW,
          },
          turnId: TURN_ID,
          createdAt: NOW,
        },
        {
          id: EventId.make("available"),
          tone: "info",
          kind: "thread-handoff.available",
          summary: "Thread handoff ready",
          payload: { handoffId: HANDOFF_ID, resolvedAt: NOW },
          turnId: TURN_ID,
          createdAt: NOW,
        },
      ],
    };

    expect(findThreadHandoff(thread, HANDOFF_ID)).toMatchObject({
      state: "available",
      prompt: "Implement the approved plan.",
    });
  });
});
