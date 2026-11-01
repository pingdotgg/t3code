import { describe, expect, it } from "vite-plus/test";

import type { AgentThreadStatus } from "./agents.ts";
import { agentChildStatusBucket, countChildStatusBuckets } from "./childStatusCounts.ts";

describe("child status counts", () => {
  it("counts Agents board children by the status their rows show", () => {
    const statuses: AgentThreadStatus[] = [
      "attention",
      "running",
      "queued",
      "waiting",
      "idle",
      "error",
      "done",
      "done",
    ];
    expect(countChildStatusBuckets(statuses, agentChildStatusBucket)).toEqual({
      needsInput: 1,
      running: 2,
      waiting: 2,
      failed: 1,
      done: 2,
    });
  });
});
