import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestChecksCountLabel } from "./pullRequestPresentation";

const checks = (...statuses: ReadonlyArray<PullRequestCheck["status"]>): PullRequestCheck[] =>
  statuses.map((status) => ({ name: "ci", status, description: null, url: null }));

describe("pullRequestChecksCountLabel", () => {
  it("names the most urgent group: failed, then awaiting action, then running", () => {
    expect(
      pullRequestChecksCountLabel(
        checks("failure", "cancelled", "action-required", "pending", "success"),
      ),
    ).toBe("2 failed");
    expect(pullRequestChecksCountLabel(checks("action-required", "pending", "pending"))).toBe(
      "1 awaiting action",
    );
    expect(pullRequestChecksCountLabel(checks("pending", "pending", "success", "skipped"))).toBe(
      "2 running",
    );
  });

  it("shows nothing once no check is failed, waiting or running", () => {
    expect(pullRequestChecksCountLabel(checks("success", "skipped", "neutral"))).toBeNull();
    expect(pullRequestChecksCountLabel([])).toBeNull();
  });
});
