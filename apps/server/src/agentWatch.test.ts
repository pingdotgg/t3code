import { describe, expect, it } from "vitest";

import { AgentWatch } from "./agentWatch";

describe("AgentWatch", () => {
  it("starts a detached job and reports non-zero exits for inspection", async () => {
    const watch = new AgentWatch(20);

    try {
      const started = watch.start({
        command: "sleep 0.05; echo boom; exit 17",
        staleAfterMs: 10_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 220));

      const status = watch.status(started.jobId);
      expect(status.status).toBe("exited");
      expect(status.exitCode).toBe(17);
      expect(status.shouldInspect).toBe(true);
      expect(status.conditions.some((condition) => condition.code === "non_zero_exit")).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  it("returns only flagged jobs by default when polling", async () => {
    const watch = new AgentWatch(20);

    try {
      watch.start({
        command: "sleep 0.2; echo done",
        staleAfterMs: 10_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      const poll = watch.poll();
      expect(poll.jobs).toHaveLength(0);
    } finally {
      watch.dispose();
    }
  });
});
