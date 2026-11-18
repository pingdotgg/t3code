import { assert, describe, expect, it } from "@effect/vitest";

import { buildRuntimeInstructions, withUserDevice } from "./runtimeInstructions.ts";

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

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "link_issue");
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
    assert.include(instructions, "Links and watches persist across pushes.");
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
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});

describe("withUserDevice", () => {
  it("names a same-machine sender with every known detail", () => {
    expect(
      withUserDevice("open the app", {
        label: "T3 Code\nDesktop",
        os: "macOS",
        deviceType: "desktop",
        surface: "desktop",
        sameMachine: true,
      }),
    ).toBe(
      '<user_device>The user sent this message from "T3 Code Desktop" (macOS desktop, desktop) on this machine.</user_device>\n\nopen the app',
    );
  });

  it("names the remote host, or says it is unknown", () => {
    expect(
      withUserDevice("hi", {
        deviceType: "mobile",
        os: "iOS",
        sameMachine: false,
        hostName: "phone.tailnet.ts.net",
      }),
    ).toBe(
      "<user_device>The user sent this message from a device (iOS mobile) on another machine (phone.tailnet.ts.net).</user_device>\n\nhi",
    );
    expect(withUserDevice("hi", { deviceType: "unknown", sameMachine: false })).toBe(
      "<user_device>The user sent this message from an unknown device on another machine (unknown host).</user_device>\n\nhi",
    );
  });

  it("leaves messages without a sender and slash commands unchanged", () => {
    expect(withUserDevice("hi", undefined)).toBe("hi");
    expect(withUserDevice("  /compact", { deviceType: "desktop", sameMachine: true })).toBe(
      "  /compact",
    );
  });
});
