import { describe, expect, it } from "vite-plus/test";

import { waitForThreadShellReady } from "./threadForkNavigation";

describe("waitForThreadShellReady", () => {
  it("returns true when the forked thread shell arrives before the deadline", async () => {
    let elapsedMs = 0;

    const ready = await waitForThreadShellReady({
      read: () => elapsedMs >= 80,
      timeoutMs: 120,
      pollIntervalMs: 40,
      now: () => elapsedMs,
      delay: async (durationMs) => {
        elapsedMs += durationMs;
      },
    });

    expect(ready).toBe(true);
  });

  it("returns false instead of navigating when the shell never arrives", async () => {
    let elapsedMs = 0;

    const ready = await waitForThreadShellReady({
      read: () => false,
      timeoutMs: 80,
      pollIntervalMs: 40,
      now: () => elapsedMs,
      delay: async (durationMs) => {
        elapsedMs += durationMs;
      },
    });

    expect(ready).toBe(false);
    expect(elapsedMs).toBe(80);
  });
});
