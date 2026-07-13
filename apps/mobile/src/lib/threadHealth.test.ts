import { describe, expect, it } from "vite-plus/test";

import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  applyThreadHealthActivity,
  createThreadHealthProjectionState,
  projectThreadHealth,
} from "./threadHealth";

function healthActivity(input: {
  readonly id: string;
  readonly state: "active" | "stalled";
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    kind: "session.health",
    tone: input.state === "stalled" ? "error" : "info",
    summary: input.state === "stalled" ? "Session stalled" : "Session active",
    payload: {
      state: input.state,
      lastActivityAt: input.lastActivityAt,
    },
    turnId: null,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.createdAt,
  };
}

describe("thread health projection", () => {
  it("keeps the newest health transition by createdAt and sequence", () => {
    const newest = healthActivity({
      id: "health-newest",
      state: "stalled",
      createdAt: "2026-04-01T00:03:00.000Z",
      lastActivityAt: "2026-04-01T00:00:00.000Z",
      sequence: 8,
    });
    const health = projectThreadHealth([
      newest,
      healthActivity({
        id: "health-older-created-at",
        state: "active",
        createdAt: "2026-04-01T00:02:00.000Z",
        lastActivityAt: "2026-04-01T00:02:00.000Z",
        sequence: 100,
      }),
      healthActivity({
        id: "health-older-sequence",
        state: "active",
        createdAt: newest.createdAt,
        lastActivityAt: "2026-04-01T00:03:00.000Z",
        sequence: 7,
      }),
    ]);

    expect(health).toEqual({
      stalled: true,
      lastActivityAt: new Date("2026-04-01T00:00:00.000Z"),
      stalledSince: new Date("2026-04-01T00:00:00.000Z"),
    });
  });

  it("keeps stalledSince anchored to the stall transition's last activity", () => {
    const stalled = healthActivity({
      id: "health-stalled",
      state: "stalled",
      createdAt: "2026-04-01T00:03:00.000Z",
      lastActivityAt: "2026-04-01T00:00:00.000Z",
      sequence: 5,
    });
    const initial = createThreadHealthProjectionState([stalled]);
    const unchanged = applyThreadHealthActivity(
      initial,
      healthActivity({
        id: "health-out-of-order-active",
        state: "active",
        createdAt: "2026-04-01T00:02:59.000Z",
        lastActivityAt: "2026-04-01T00:02:59.000Z",
        sequence: 4,
      }),
    );

    expect(unchanged.health?.stalledSince).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(unchanged).toBe(initial);
  });
});
