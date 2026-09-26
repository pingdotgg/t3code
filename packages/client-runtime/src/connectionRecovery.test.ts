import {
  EventId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveConnectionRecoveryNotice } from "./connectionRecovery.ts";

const createdAt = "2026-09-01T00:00:00.000Z";
const interruptedTurn: OrchestrationLatestTurn = {
  turnId: TurnId.make("interrupted"),
  state: "error",
  requestedAt: createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  assistantMessageId: null,
};
function activity(kind: string, sequence = 1): OrchestrationThreadActivity {
  return {
    id: EventId.make(`recovery-${sequence}`),
    kind,
    sequence,
    tone: "info",
    summary: "Recovery update",
    createdAt,
    turnId: interruptedTurn.turnId,
    payload: { interruptedTurnId: interruptedTurn.turnId, resumedTurnId: "resumed" },
  };
}
const waiting = activity("connection.recovery.waiting");
const input = {
  activities: [waiting],
  latestTurn: interruptedTurn,
  enabled: true,
  pendingRequest: false,
  now: Date.parse(createdAt),
};

describe("connection recovery notices", () => {
  it("shows waiting only for an opted-in, confirmed interruption", () => {
    expect(deriveConnectionRecoveryNotice(input)?.label).toBe(
      "Connection lost. Waiting to resume…",
    );
    expect(deriveConnectionRecoveryNotice({ ...input, enabled: false })).toBeNull();
    expect(deriveConnectionRecoveryNotice({ ...input, activities: [] })).toBeNull();
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        latestTurn: { ...interruptedTurn, state: "running" },
      }),
    ).toBeNull();
  });

  it.each(["waiting", "failed"])(
    "suppresses stale %s notices after newer work or completion",
    (kind) => {
      const current = { ...input, activities: [activity(`connection.recovery.${kind}`)] };
      expect(
        deriveConnectionRecoveryNotice({
          ...current,
          latestTurn: { ...interruptedTurn, state: "completed" },
        }),
      ).toBeNull();
      expect(
        deriveConnectionRecoveryNotice({
          ...current,
          latestTurn: { ...interruptedTurn, turnId: TurnId.make("newer") },
        }),
      ).toBeNull();
    },
  );

  it("does not revive waiting when cancellation arrives out of array order", () => {
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        activities: [activity("connection.recovery.cancelled", 2), waiting],
      }),
    ).toBeNull();
  });

  it("announces confirmed recovery briefly and only for the recovered turn", () => {
    const resumed = {
      ...input,
      activities: [waiting, activity("connection.recovery.resumed", 2)],
      latestTurn: { ...interruptedTurn, turnId: TurnId.make("resumed"), state: "running" as const },
    };
    expect(deriveConnectionRecoveryNotice(resumed)?.label).toBe("Task resumed");
    expect(deriveConnectionRecoveryNotice({ ...resumed, now: input.now + 60_000 })).toBeNull();
    expect(deriveConnectionRecoveryNotice({ ...resumed, latestTurn: interruptedTurn })).toBeNull();
    expect(
      deriveConnectionRecoveryNotice({
        ...resumed,
        latestTurn: { ...resumed.latestTurn, state: "interrupted" },
      }),
    ).toBeNull();
  });

  it.each(["waiting", "resumed", "failed"])(
    "lets pending approvals or questions take precedence over %s",
    (kind) => {
      expect(
        deriveConnectionRecoveryNotice({
          ...input,
          pendingRequest: true,
          latestTurn:
            kind === "resumed"
              ? { ...interruptedTurn, turnId: TurnId.make("resumed"), state: "running" }
              : interruptedTurn,
          activities: [activity(`connection.recovery.${kind}`)],
        }),
      ).toBeNull();
    },
  );

  it("shows recovery failure on the admitted continuation turn", () => {
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        latestTurn: { ...interruptedTurn, turnId: TurnId.make("resumed") },
        activities: [activity("connection.recovery.failed")],
      })?.kind,
    ).toBe("failed");
  });

  it("offers Stop after cleanup fails even while the resumed turn is running", () => {
    const failed = {
      ...activity("connection.recovery.failed"),
      payload: {
        resumedTurnId: "resumed",
        reason: "cancellation-failed",
        detail: "Private diagnostic",
      },
    };
    for (const latestTurn of [
      interruptedTurn,
      { ...interruptedTurn, turnId: TurnId.make("resumed"), state: "running" as const },
    ]) {
      expect(
        deriveConnectionRecoveryNotice({
          ...input,
          enabled: false,
          latestTurn,
          activities: [failed],
        }),
      ).toEqual({
        kind: "stop-failed",
        label: "Could not stop automatic recovery. Use Stop before continuing.",
        expiresAt: null,
      });
    }
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        latestTurn: { ...interruptedTurn, turnId: TurnId.make("newer"), state: "running" },
        activities: [failed],
      }),
    ).toBeNull();
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        activities: [failed, activity("connection.recovery.cancelled", 2)],
      }),
    ).toBeNull();
  });

  it("leaves a concise failure notice without exposing provider diagnostics", () => {
    expect(
      deriveConnectionRecoveryNotice({
        ...input,
        activities: [
          {
            ...activity("connection.recovery.failed"),
            payload: { detail: "Private provider diagnostic" },
          },
        ],
      })?.label,
    ).toBe("Couldn't resume automatically. Continue the task manually.");
  });
});
