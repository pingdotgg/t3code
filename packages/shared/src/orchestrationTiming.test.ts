import { describe, expect, it } from "vite-plus/test";

import { deriveActiveWorkStartedAt, deriveSubagentElapsedMs } from "./orchestrationTiming.ts";

describe("deriveActiveWorkStartedAt", () => {
  it.each([null, "2026-09-06T23:34:00.000Z"])(
    "does not time a superseded turn when the active turn differs",
    (sendStartedAt) => {
      expect(
        deriveActiveWorkStartedAt(
          {
            runId: "old",
            requestedAt: "2026-09-06T23:33:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          { orchestrationStatus: "running", activeRunId: "new" },
          sendStartedAt,
        ),
      ).toBe(sendStartedAt);
    },
  );

  it("stops timing a turn that failed before its provider started", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: "2026-09-06T23:33:05.000Z",
        },
        { orchestrationStatus: "error", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });
  it("counts from requestedAt while the provider is still starting", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        { orchestrationStatus: "starting", activeRunId: null },
        null,
      ),
    ).toBe("2026-09-06T23:33:00.000Z");
  });

  it("prefers the turn's own startedAt once the provider reports it", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: null,
        },
        { orchestrationStatus: "running", activeRunId: "turn-1" },
        null,
      ),
    ).toBe("2026-09-06T23:33:05.000Z");
  });

  it("stops counting once the turn has settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "idle", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });

  it("does not count a settled turn while a session is starting again", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "starting", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });
});

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});
