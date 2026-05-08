import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  deriveLatestContextWindowSnapshotForTurn,
  deriveLatestUnassignedContextWindowSnapshotSince,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  overrides?: Partial<OrchestrationThreadActivity>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("preserves explicit generation duration when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        lastOutputTokens: 1_790,
        durationMs: 25_000,
        timeToFirstTokenMs: 4_300,
      }),
    ]);

    expect(snapshot?.lastOutputTokens).toBe(1_790);
    expect(snapshot?.durationMs).toBe(25_000);
    expect(snapshot?.timeToFirstTokenMs).toBe(4_300);
  });

  it("can select the latest valid context window snapshot for a specific turn", () => {
    const snapshot = deriveLatestContextWindowSnapshotForTurn(
      [
        {
          ...makeActivity("activity-1", "context-window.updated", {
            usedTokens: 8_000,
            lastOutputTokens: 900,
          }),
          turnId: TurnId.make("turn-0"),
        },
        makeActivity("activity-2", "context-window.updated", {
          usedTokens: 4_000,
          lastOutputTokens: 321,
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(snapshot?.usedTokens).toBe(4_000);
    expect(snapshot?.lastOutputTokens).toBe(321);
  });

  it("can select the latest unassigned context window snapshot after a turn starts", () => {
    const snapshot = deriveLatestUnassignedContextWindowSnapshotSince(
      [
        makeActivity(
          "activity-1",
          "context-window.updated",
          { usedTokens: 9_000, lastOutputTokens: 900 },
          { turnId: null, createdAt: "2026-03-22T23:59:59.000Z" },
        ),
        makeActivity(
          "activity-2",
          "context-window.updated",
          { usedTokens: 4_000, lastOutputTokens: 321 },
          { turnId: null, createdAt: "2026-03-23T00:00:10.000Z" },
        ),
        makeActivity(
          "activity-3",
          "context-window.updated",
          { usedTokens: 5_000, lastOutputTokens: 654 },
          { turnId: TurnId.make("turn-2"), createdAt: "2026-03-23T00:00:11.000Z" },
        ),
      ],
      "2026-03-23T00:00:00.000Z",
    );

    expect(snapshot?.usedTokens).toBe(4_000);
    expect(snapshot?.lastOutputTokens).toBe(321);
  });
});
