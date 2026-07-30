import { describe, expect, it } from "vite-plus/test";

import { formatWorkingTimelineDuration } from "./workingTimelineDuration";

describe("formatWorkingTimelineDuration", () => {
  it("preserves elapsed time for a server timestamp in the past", () => {
    const observedAtMs = Date.parse("2026-07-31T12:00:10.000Z");

    expect(
      formatWorkingTimelineDuration("2026-07-31T12:00:00.000Z", observedAtMs, observedAtMs + 5_000),
    ).toBe("15s");
  });

  it("advances from when a future server timestamp is first observed", () => {
    const observedAtMs = Date.parse("2026-07-31T12:00:00.000Z");
    const serverStartedAt = "2026-07-31T12:00:53.000Z";

    expect(formatWorkingTimelineDuration(serverStartedAt, observedAtMs, observedAtMs + 5_000)).toBe(
      "5.0s",
    );
  });

  it("anchors a new work session to its own observation time", () => {
    const firstObservedAtMs = Date.parse("2026-07-31T12:00:00.000Z");
    const secondObservedAtMs = firstObservedAtMs + 30_000;

    expect(
      formatWorkingTimelineDuration(
        "2026-07-31T12:00:53.000Z",
        firstObservedAtMs,
        firstObservedAtMs + 5_000,
      ),
    ).toBe("5.0s");
    expect(
      formatWorkingTimelineDuration(
        "2026-07-31T12:01:23.000Z",
        secondObservedAtMs,
        secondObservedAtMs + 3_000,
      ),
    ).toBe("3.0s");
  });

  it("keeps the existing fallback for an invalid server timestamp", () => {
    const observedAtMs = Date.parse("2026-07-31T12:00:00.000Z");

    expect(formatWorkingTimelineDuration("invalid", observedAtMs, observedAtMs + 5_000)).toBe("0s");
  });
});
