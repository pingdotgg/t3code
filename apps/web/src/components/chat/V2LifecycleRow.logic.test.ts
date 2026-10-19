import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { subagentResumedSince } from "./V2LifecycleRow.logic";

const failedAt = "2026-10-09T12:21:00.000Z";
const beforeFailure = DateTime.makeUnsafe("2026-10-09T12:05:00.000Z");
const afterFailure = DateTime.makeUnsafe("2026-10-09T12:48:00.000Z");

describe("subagentResumedSince", () => {
  it("is true while a resumed subagent runs", () => {
    expect(subagentResumedSince({ status: "running", startedAt: afterFailure }, failedAt)).toBe(
      true,
    );
  });

  it("is true while it runs even when the notification was delivered after the resume", () => {
    expect(
      subagentResumedSince(
        { status: "running", startedAt: afterFailure },
        "2026-10-09T12:50:00.000Z",
      ),
    ).toBe(true);
  });

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

  it("is false for a settled subagent with no start time", () => {
    expect(subagentResumedSince({ status: "failed", startedAt: null }, failedAt)).toBe(false);
  });
});
