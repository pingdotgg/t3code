import { assert, describe, it } from "@effect/vitest";

import { forgejoChecks } from "./forgejoPullRequestJson.ts";

const status = (context: string, state: string) => ({
  context,
  status: state,
  description: null,
  target_url: null,
  updated_at: "2026-10-05T12:00:00Z",
});

describe("forgejoChecks", () => {
  it("maps every Forgejo status state onto a check status, and unknown ones to pending", () => {
    const checks = forgejoChecks([
      status("CI / checks (pull_request)", "success"),
      status("CI / e2e (pull_request)", "failure"),
      status("CI / lint (pull_request)", "error"),
      status("CI / deploy (pull_request)", "skipped"),
      status("CI / audit (pull_request)", "warning"),
      status("CI / build (pull_request)", "pending"),
      status("CI / docs (pull_request)", "future-state"),
    ]);
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ["CI / checks (pull_request)", "success"],
        ["CI / e2e (pull_request)", "failure"],
        ["CI / lint (pull_request)", "failure"],
        ["CI / deploy (pull_request)", "skipped"],
        ["CI / audit (pull_request)", "neutral"],
        ["CI / build (pull_request)", "pending"],
        ["CI / docs (pull_request)", "pending"],
      ],
    );
  });
});
