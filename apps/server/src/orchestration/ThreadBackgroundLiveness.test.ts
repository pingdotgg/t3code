import { describe, expect, it } from "vite-plus/test";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

describe("ThreadBackgroundLiveness", () => {
  it("agents present as working; monitors as monitoring; agents win", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-1";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("terminal rows without a taskType still clear monitor entries", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-2";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    // Terminal tick arrives with no taskType (common on task.completed).
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("nested agents (agentId + agent taskType) still count toward liveness", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-nested";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: "completed",
      kind: "completed",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("untyped rows count as agents; idle is not live; agent-owned tasks are ignored", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-3";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
    liveness.recordTaskLiveness({
      threadId,
      taskId: "sh:1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("reclassification moves a task between buckets instead of duplicating it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-reclass";
    // First seen without a taskType: counts as an agent.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: undefined,
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    // Later transition reveals it's a shell: downgrade to monitoring, not
    // a stale duplicate pinning "working".
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    // Turning out to be inert or agent-owned drops the prior entry too.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("retains only bounded indexed anchors for live agents and clears them on settle", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-anchors";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "running",
      kind: "started",
      activityId: "activity-start",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "waiting",
      kind: "updated",
      activityId: "activity-update-old",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "running",
      kind: "updated",
      activityId: "activity-update-latest",
    });

    expect([...liveness.getThreadLiveAgentIds(threadId)]).toEqual(["a1"]);
    expect([...liveness.getThreadLiveAgentActivityIds(threadId)].toSorted()).toEqual([
      "activity-start",
      "activity-update-latest",
    ]);

    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: undefined,
      status: "completed",
      kind: "completed",
      activityId: "activity-completed",
    });
    expect(liveness.getThreadLiveAgentIds(threadId).size).toBe(0);
    expect(liveness.getThreadLiveAgentActivityIds(threadId).size).toBe(0);
  });

  it("ignores status-less progress after completion until a new start", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-terminal-usage";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });

    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();

    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
  });

  it("retains terminal tombstones across session exit", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-terminal-session-exit";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });

    liveness.clearThreadLiveness(threadId);
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();

    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
  });

  it("does not resurrect a completed task from trailing running progress", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-terminal-trailing-progress";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });

    liveness.recordTaskLiveness({
      threadId,
      taskId: "codex-child",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });

    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("expires terminal tombstones using the injected clock", () => {
    let nowMs = 1_000;
    const liveness = ThreadBackgroundLiveness.make(() => nowMs);
    const threadId = "t-terminal-expiry";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "expired-child",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId,
      taskId: "expired-child",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });

    nowMs += 60 * 60 * 1_000;
    liveness.recordTaskLiveness({
      threadId,
      taskId: "expired-child",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();

    nowMs += 2 * 60 * 60 * 1_000;
    liveness.recordTaskLiveness({
      threadId,
      taskId: "expired-child",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
  });

  it("plan tasks are inert; clear removes everything; instances are isolated", () => {
    const a = ThreadBackgroundLiveness.make();
    const b = ThreadBackgroundLiveness.make();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "local_workflow",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBe("working");
    expect(b.getThreadBackgroundLiveness("t")).toBeNull();
    a.clearThreadLiveness("t");
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
  });
});
