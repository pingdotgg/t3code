import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpDispatchMode } from "./followUpBehavior";

describe("resolveFollowUpDispatchMode", () => {
  const running = {
    running: true,
    canSteer: true,
    isCompacting: false,
    followUpBehavior: "steer",
  } as const;

  it("lets the server decide while the thread is idle", () => {
    expect(resolveFollowUpDispatchMode({ ...running, running: false })).toBeNull();
  });

  it("sends steering as auto and queueing as queue", () => {
    expect(resolveFollowUpDispatchMode(running)).toBe("auto");
    expect(resolveFollowUpDispatchMode({ ...running, followUpBehavior: "queue" })).toBe("queue");
    expect(resolveFollowUpDispatchMode({ ...running, followUpOverride: "queue" })).toBe("queue");
  });

  it("queues explicitly while compacting, matching the Queue label", () => {
    // While /compact is still being dispatched the active run is the ordinary
    // one, which an auto send would steer.
    expect(resolveFollowUpDispatchMode({ ...running, canSteer: false, isCompacting: true })).toBe(
      "queue",
    );
  });
});
