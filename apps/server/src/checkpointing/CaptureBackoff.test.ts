import { describe, expect, it } from "vite-plus/test";

import { cooldownForFailureCount, makeCaptureBackoff } from "./CaptureBackoff.ts";

const MINUTE = 60_000;
const CWD = "/repo/workspace";

describe("cooldownForFailureCount", () => {
  it("tolerates transient failures before opening a cooldown", () => {
    expect(cooldownForFailureCount(1)).toBe(0);
    expect(cooldownForFailureCount(2)).toBe(0);
  });

  it("backs off further the longer capture keeps failing", () => {
    expect(cooldownForFailureCount(3)).toBe(5 * MINUTE);
    expect(cooldownForFailureCount(4)).toBe(10 * MINUTE);
    expect(cooldownForFailureCount(5)).toBe(20 * MINUTE);
  });

  it("caps the cooldown so a workspace is retried eventually", () => {
    expect(cooldownForFailureCount(20)).toBe(60 * MINUTE);
    expect(cooldownForFailureCount(500)).toBe(60 * MINUTE);
  });
});

describe("makeCaptureBackoff", () => {
  it("does not skip before the failure threshold is reached", () => {
    const backoff = makeCaptureBackoff<string>();

    backoff.recordFailure(CWD, 0, "timeout");
    backoff.recordFailure(CWD, 1_000, "timeout");

    expect(backoff.evaluate(CWD, 2_000).skip).toBe(false);
  });

  it("skips and replays the recorded failure once capture keeps failing", () => {
    const backoff = makeCaptureBackoff<string>();

    for (const at of [0, 1_000, 2_000]) {
      backoff.recordFailure(CWD, at, "git add timed out");
    }

    const decision = backoff.evaluate(CWD, 3_000);
    expect(decision.skip).toBe(true);
    expect(decision.lastError).toBe("git add timed out");
    expect(decision.remainingMs).toBeGreaterThan(0);
  });

  it("retries again once the cooldown elapses", () => {
    const backoff = makeCaptureBackoff<string>();

    for (const at of [0, 0, 0]) {
      backoff.recordFailure(CWD, at, "timeout");
    }

    expect(backoff.evaluate(CWD, 5 * MINUTE - 1).skip).toBe(true);
    expect(backoff.evaluate(CWD, 5 * MINUTE).skip).toBe(false);
  });

  it("clears the record after a capture succeeds", () => {
    const backoff = makeCaptureBackoff<string>();

    for (const at of [0, 0, 0]) {
      backoff.recordFailure(CWD, at, "timeout");
    }
    expect(backoff.evaluate(CWD, 1_000).skip).toBe(true);

    backoff.recordSuccess(CWD);

    expect(backoff.evaluate(CWD, 1_000).skip).toBe(false);
    expect(backoff.trackedWorkspaceCount).toBe(0);
  });

  it("tracks each workspace independently", () => {
    const backoff = makeCaptureBackoff<string>();
    const healthy = "/repo/other";

    for (const at of [0, 0, 0]) {
      backoff.recordFailure(CWD, at, "timeout");
    }

    expect(backoff.evaluate(CWD, 1_000).skip).toBe(true);
    expect(backoff.evaluate(healthy, 1_000).skip).toBe(false);
  });

  it("bounds how many workspaces it retains", () => {
    const backoff = makeCaptureBackoff<string>();

    for (let index = 0; index < 400; index += 1) {
      backoff.recordFailure(`/repo/workspace-${index}`, index, "timeout");
    }

    expect(backoff.trackedWorkspaceCount).toBe(256);
    // The oldest entries are the ones dropped: an evicted workspace starts
    // counting again from one, a retained one continues.
    expect(backoff.recordFailure("/repo/workspace-0", 1_000, "timeout")).toBe(1);
    expect(backoff.recordFailure("/repo/workspace-399", 1_000, "timeout")).toBe(2);
  });

  it("keeps a repeatedly failing workspace alive through eviction pressure", () => {
    const backoff = makeCaptureBackoff<string>();

    // A workspace in active use fails on every turn while many one-off
    // workspaces churn past it.
    for (let index = 0; index < 400; index += 1) {
      backoff.recordFailure(CWD, index, "timeout");
      backoff.recordFailure(`/repo/other-${index}`, index, "timeout");
    }

    expect(backoff.evaluate(CWD, 400).skip).toBe(true);
  });

  it("keeps extending the cooldown while failures continue", () => {
    const backoff = makeCaptureBackoff<string>();

    for (const at of [0, 0, 0]) {
      backoff.recordFailure(CWD, at, "timeout");
    }
    const firstRemaining = backoff.evaluate(CWD, 0).remainingMs;

    // The next attempt after the cooldown fails again, so the wait grows.
    backoff.recordFailure(CWD, 5 * MINUTE, "timeout");
    const secondRemaining = backoff.evaluate(CWD, 5 * MINUTE).remainingMs;

    expect(secondRemaining).toBeGreaterThan(firstRemaining);
  });
});
