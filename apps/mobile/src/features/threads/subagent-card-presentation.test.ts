import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentCardDetail, subagentCardElapsed } from "./subagent-card-presentation";

describe("subagent card", () => {
  it.each([
    ["![screenshot](screenshots/shot.png) Verified", "screenshot Verified"],
    ["[docs](https://en.wikipedia.org/wiki/T3_(protocol))", "docs"],
    ["[report](outputs/report%20(final).md)", "report"],
    ["[report](outputs/report\\(final.md)", "report"],
  ])("strips image and link markup from %s", (detail, expected) => {
    expect(subagentCardDetail(detail)).toBe(expected);
  });

  const start = DateTime.makeUnsafe("2026-09-21T12:00:00Z");
  const end = DateTime.makeUnsafe("2026-09-21T12:01:00Z");
  const later = DateTime.makeUnsafe("2026-09-21T12:02:00Z");
  const done = { status: "completed" as const, startedAt: start, completedAt: end };

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
