import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentCardDetail, subagentCardElapsed } from "./subagent-card-presentation";

describe("subagent card", () => {
  it("shows readable result text and suppresses generic completion messages", () => {
    expect(
      subagentCardDetail(
        "- Updated `app.ts` with [the fix](https://example.com).\n- Checked tests.",
      ),
    ).toBe("Updated app.ts with the fix. Checked tests.");
    expect(subagentCardDetail("Child task ended with status failed.")).toBeNull();
    expect(subagentCardDetail("  ")).toBeNull();
  });

  const start = DateTime.makeUnsafe("2026-09-21T12:00:00Z");
  const end = DateTime.makeUnsafe("2026-09-21T12:01:00Z");
  const later = DateTime.makeUnsafe("2026-09-21T12:02:00Z");
  const done = { status: "completed" as const, startedAt: start, completedAt: end };

  it("freezes settled durations and spans the group's wall time", () => {
    expect(subagentCardElapsed([done], DateTime.toEpochMillis(later))).toBe("1m");
    expect(
      subagentCardElapsed(
        [done, { ...done, startedAt: end, completedAt: later }],
        DateTime.toEpochMillis(later),
      ),
    ).toBe("2m");
  });

  it("counts live work but never uses a settled agent's age as its duration", () => {
    const unfinished = { ...done, completedAt: null };
    expect(subagentCardElapsed([unfinished], DateTime.toEpochMillis(later))).toBeNull();
    expect(
      subagentCardElapsed([{ ...unfinished, status: "running" }], DateTime.toEpochMillis(later)),
    ).toBe("2m");
    expect(
      subagentCardElapsed([{ ...unfinished, status: "idle" }], DateTime.toEpochMillis(later)),
    ).toBeNull();
    expect(
      subagentCardElapsed([{ ...done, startedAt: null }], DateTime.toEpochMillis(later)),
    ).toBeNull();
  });
});
