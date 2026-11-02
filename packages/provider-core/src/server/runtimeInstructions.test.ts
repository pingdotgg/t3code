import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links persist across pushes; active watches do too.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is the `report` line from pull_request_status.",
    );
    assert.include(instructions, "Never wait with sleep");
    assert.include(instructions, 'New watches default to mode "checks"');
    assert.include(instructions, "all reported checks finish, even failed or cancelled ones");
    assert.include(
      instructions,
      'Use mode "review" for ongoing checks and review monitoring after CI finishes',
    );
    assert.include(instructions, "Omitting mode on an existing watch keeps its mode.");
    assert.include(instructions, "call unwatch_pull_request");
  });

  it("sends PR reads through T3's tools and keeps gh for writes and gaps", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Read pull requests through T3.");
    assert.include(
      instructions,
      "pull_request_status returns head, checks, reviews and mergeability",
    );
    assert.include(instructions, "gh spends the same GitHub rate limit");
    assert.include(instructions, "stop all GitHub reads, gh included, until the time it names");
  });
});
