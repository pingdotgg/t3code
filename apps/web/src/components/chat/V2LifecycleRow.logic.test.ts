import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  isActiveThreadRelationshipStatus,
  isPendingThreadRelationshipStatus,
} from "./ThreadRelationshipIcon";
import { resolveSubagentDisplayStatus, subagentResumedSince } from "./V2LifecycleRow.logic";

const failedAt = "2026-10-09T12:21:00.000Z";
const beforeFailure = DateTime.makeUnsafe("2026-10-09T12:05:00.000Z");
const afterFailure = DateTime.makeUnsafe("2026-10-09T12:48:00.000Z");

describe("subagentResumedSince", () => {
  it("is true while it runs even when the notification was delivered after the resume", () => {
    expect(
      subagentResumedSince(
        { status: "running", startedAt: afterFailure },
        "2026-10-09T12:50:00.000Z",
      ),
    ).toBe(true);
  });

  // regression: #18099 a resumed subagent's old failure notification row showed failed instead of resumed
  it("is true once a run started after the notification has settled", () => {
    expect(subagentResumedSince({ status: "completed", startedAt: afterFailure }, failedAt)).toBe(
      true,
    );
  });

  it("is false for the run the notification reported on", () => {
    expect(subagentResumedSince({ status: "failed", startedAt: beforeFailure }, failedAt)).toBe(
      false,
    );
  });
});

describe("resolveSubagentDisplayStatus", () => {
  it.each([
    { activityRunStatus: "starting", status: "starting", expected: "starting" },
    { activityRunStatus: "preparing", status: "preparing", expected: "preparing" },
    { activityRunStatus: null, status: "queued", expected: "queued" },
  ] as const)(
    "reflects child $expected status while the parent subagent is active",
    ({ activityRunStatus, status, expected }) => {
      expect(resolveSubagentDisplayStatus("running", { activityRunStatus, status })).toBe(expected);
    },
  );

  it("keeps the parent status once the child is running, missing, or the subagent is settled", () => {
    expect(
      resolveSubagentDisplayStatus("running", { activityRunStatus: "running", status: "running" }),
    ).toBe("running");
    expect(resolveSubagentDisplayStatus("running", null)).toBe("running");
    expect(
      resolveSubagentDisplayStatus("completed", {
        activityRunStatus: "starting",
        status: "starting",
      }),
    ).toBe("completed");
  });
});

describe("thread relationship status helpers", () => {
  it("treats preparing, starting, and queued as active pending statuses", () => {
    for (const status of ["preparing", "starting", "queued", "pending"]) {
      expect(isActiveThreadRelationshipStatus(status)).toBe(true);
      expect(isPendingThreadRelationshipStatus(status)).toBe(true);
    }
    expect(isActiveThreadRelationshipStatus("running")).toBe(true);
    expect(isPendingThreadRelationshipStatus("running")).toBe(false);
    expect(isActiveThreadRelationshipStatus("completed")).toBe(false);
    expect(isActiveThreadRelationshipStatus("idle")).toBe(false);
    expect(isActiveThreadRelationshipStatus(null)).toBe(false);
  });
});
