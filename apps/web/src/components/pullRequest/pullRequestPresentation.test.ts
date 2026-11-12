import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestChecksCountLabel, pullRequestChecksState } from "./pullRequestPresentation";

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

describe("pullRequestChecksState", () => {
  const mixed: ReadonlyArray<PullRequestCheck> = [
    { name: "build", status: "success", description: null, url: null, required: true },
    { name: "style", status: "failure", description: null, url: null },
  ];

  it("gates Forgejo on required checks and other providers on every check", () => {
    expect(pullRequestChecksState(mixed, "forgejo")).toBe("passing");
    expect(pullRequestChecksState(mixed, "github")).toBe("failing");
    expect(pullRequestChecksState(mixed)).toBe("failing");
  });
});
