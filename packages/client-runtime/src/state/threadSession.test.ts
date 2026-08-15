import { describe, expect, it } from "vite-plus/test";

import { threadSessionReloadAvailability } from "./threadSession.ts";

describe("threadSessionReloadAvailability", () => {
  it.each(["idle", "ready", "interrupted", "error"] as const)("allows reload from %s", (status) => {
    expect(threadSessionReloadAvailability(status)).toBe("available");
  });

  it.each(["starting", "running"] as const)("protects an active turn in %s", (status) => {
    expect(threadSessionReloadAvailability(status)).toBe("disabled");
  });

  it.each([null, "stopped"] as const)("hides reload for %s", (status) => {
    expect(threadSessionReloadAvailability(status)).toBe("hidden");
  });
});
