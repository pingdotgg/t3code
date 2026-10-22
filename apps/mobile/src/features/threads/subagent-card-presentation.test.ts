import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentCardElapsed } from "./subagent-card-presentation";
import { resolveSubagentRowPresentation, subagentThreadTarget } from "./threadAgentsPresentation";

describe("subagent card", () => {
  const start = DateTime.makeUnsafe("2026-09-21T12:00:00Z");
  const end = DateTime.makeUnsafe("2026-09-21T12:01:00Z");
  const later = DateTime.makeUnsafe("2026-09-21T12:02:00Z");
  const done = { status: "completed" as const, startedAt: start, completedAt: end };

  it("keeps a pending remote launch visible without opening a nonexistent thread", () => {
    const pending = {
      title: null,
      prompt: "Audit the timestamps",
      status: "running" as const,
      result: null,
      childThreadId: null,
      remoteChild: { environmentId: "environment-box" as never, label: "Box" },
    };
    expect(resolveSubagentRowPresentation(pending, true)).toMatchObject({
      runsOn: "Box",
      statusLabel: "Launching",
      canOpenThread: false,
    });
    expect(subagentThreadTarget(pending, "environment-here" as never, () => true)).toBeNull();
    const launchError = "Launch unconfirmed; work may still be running on Box.";
    expect(
      resolveSubagentRowPresentation(
        {
          ...pending,
          status: "cancelled",
          result: "Cancelled.",
          remoteChild: { ...pending.remoteChild, launchError },
        },
        true,
      ),
    ).toMatchObject({ statusLabel: "Cancelled", detail: launchError, canOpenThread: false });
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
