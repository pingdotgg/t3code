import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentCardElapsed } from "./subagent-card-presentation";

describe("subagent card", () => {
  const start = DateTime.makeUnsafe("2026-09-21T12:00:00Z");
  const end = DateTime.makeUnsafe("2026-09-21T12:01:00Z");
  const later = DateTime.makeUnsafe("2026-09-21T12:02:00Z");
  const done = { status: "completed" as const, startedAt: start, completedAt: end };

  it("counts live work but never uses a settled agent's age as its duration", () => {
    const unfinished = { ...done, completedAt: null };
    expect(subagentCardElapsed([unfinished], DateTime.toEpochMillis(later))).toBeNull();
    expect(
      subagentCardElapsed([{ ...unfinished, status: "running" }], DateTime.toEpochMillis(later)),
    ).toBe("2m 0s");
    expect(
      subagentCardElapsed([{ ...unfinished, status: "idle" }], DateTime.toEpochMillis(later)),
    ).toBeNull();
    expect(
      subagentCardElapsed([{ ...done, startedAt: null }], DateTime.toEpochMillis(later)),
    ).toBeNull();
    const fractionalStart = DateTime.makeUnsafe("2026-09-21T12:00:00.400Z");
    const agent = { ...done, startedAt: fractionalStart };
    const running = { ...agent, status: "running" as const };
    const startMs = DateTime.toEpochMillis(start);
    expect([0, 8_000].map((offset) => subagentCardElapsed([running], startMs + offset))).toEqual([
      "0s",
      "7s",
    ]);
    expect(
      subagentCardElapsed(
        [{ ...agent, completedAt: DateTime.makeUnsafe("2026-09-21T12:00:08.000Z") }],
        DateTime.toEpochMillis(later),
      ),
    ).toBe("7.6s");
  });
});
