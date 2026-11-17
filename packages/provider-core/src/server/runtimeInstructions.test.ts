import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("guides agents to link the PRs and issues they take on", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(
      instructions,
      "Next call: use link_pull_request for each PR you create, take over, or push to",
    );
    assert.include(instructions, "every stack layer");
    assert.include(
      instructions,
      "Skip PRs and issues you only read, review, or mention as background",
    );
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
    assert.include(instructions, "call link_issue for each issue you take on or file");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Use watch_pull_request when asked to monitor or babysit, or when your task waits on checks or reviews, even after unwatching",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act or hand back.");
    assert.include(instructions, "Push needed updates first");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "Delegated children never watch");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});
