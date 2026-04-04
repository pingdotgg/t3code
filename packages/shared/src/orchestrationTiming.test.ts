import { describe, expect, it } from "vitest";
import { TurnId } from "@t3tools/contracts";

import {
  deriveActiveWorkStartedAt,
  formatDuration,
  formatElapsed,
  isLatestTurnSettled,
} from "./orchestrationTiming";

describe("orchestrationTiming", () => {
  it("formats elapsed durations consistently", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(12_600)).toBe("13s");
    expect(formatElapsed("2026-03-27T09:00:00.000Z", "2026-03-27T09:12:36.000Z")).toBe("12m 36s");
  });

  it("treats a running latest turn as unsettled", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-03-27T09:00:00.000Z",
          completedAt: "2026-03-27T09:00:06.000Z",
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
      ),
    ).toBe(false);
  });

  it("prefers the in-flight turn start while work is active", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-03-27T09:00:00.000Z",
          completedAt: "2026-03-27T09:00:06.000Z",
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-03-27T09:01:00.000Z",
      ),
    ).toBe("2026-03-27T09:00:00.000Z");
  });

  it("falls back to the local send start once the prior turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-03-27T09:00:00.000Z",
          completedAt: "2026-03-27T09:00:06.000Z",
        },
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-03-27T09:01:00.000Z",
      ),
    ).toBe("2026-03-27T09:01:00.000Z");
  });
});
