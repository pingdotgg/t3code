import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("asks agents to link only the pull requests they create", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "every pull request you create");
    assert.include(instructions, "Do not link PRs you only read, review, or score.");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });
});
