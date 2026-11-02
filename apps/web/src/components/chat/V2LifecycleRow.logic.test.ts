import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { plainDetail, subagentResumedSince } from "./V2LifecycleRow.logic";

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

describe("plainDetail", () => {
  it.each([
    ["![screenshot](screenshots/shot.png) Verified", "screenshot Verified"],
    ["[docs](https://en.wikipedia.org/wiki/T3_(protocol))", "docs"],
    ["[report](outputs/report%20(final).md)", "report"],
    ["[report](outputs/report\\(final.md)", "report"],
  ])("strips image and link markup from %s", (detail, expected) => {
    expect(plainDetail(detail)).toBe(expected);
  });
});
