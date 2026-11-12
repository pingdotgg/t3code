import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestChecksState } from "./pullRequestPresentation";

describe("pullRequestChecksState", () => {
  const checks: ReadonlyArray<PullRequestCheck> = [
    { name: "build", status: "success", description: null, url: null, required: true },
    { name: "style", status: "failure", description: null, url: null },
  ];

  it("gates Forgejo on required checks and other providers on every check", () => {
    expect(pullRequestChecksState(checks, "forgejo")).toBe("passing");
    expect(pullRequestChecksState(checks, "github")).toBe("failing");
    expect(pullRequestChecksState(checks)).toBe("failing");
  });
});
