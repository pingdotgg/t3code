import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { currentSubagent, resolveThreadLineageWindow } from "./ThreadRelationshipsControl";

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

describe("thread lineage window", () => {
  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("hides nothing when everything fits", () => {
    expect(resolveThreadLineageWindow(rows, rows.length).hiddenCount).toBe(0);
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });
});

describe("current subagent", () => {
  const agent = (status: string) =>
    ({
      status,
      startedAt: "2026-10-18T13:50:43.230Z",
      completedAt: null,
      updatedAt: "2026-10-18T13:50:43.230Z",
    }) as never;
  const settledChild = {
    status: "completed",
    activityRunStatus: null,
    latestRunRequestedAt: DateTime.makeUnsafe("2026-10-18T13:58:35.059Z"),
    latestRunStartedAt: DateTime.makeUnsafe("2026-10-18T13:58:35.060Z"),
    latestRunCompletedAt: DateTime.makeUnsafe("2026-10-18T13:58:51.404Z"),
  } as never;

  it.each(["running", "waiting", "pending"])(
    "keeps an unfinished %s subagent when its child's latest run settled",
    (status) => {
      expect(currentSubagent(agent(status), settledChild)).toMatchObject({ status });
    },
  );

  it("takes the child's settled status once the subagent finished", () => {
    expect(currentSubagent(agent("failed"), settledChild)).toMatchObject({ status: "completed" });
  });
});
