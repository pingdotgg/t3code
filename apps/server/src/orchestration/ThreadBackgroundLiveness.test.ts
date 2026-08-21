import { describe, expect, it } from "vite-plus/test";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

describe("ThreadBackgroundLiveness", () => {
  it("does not let status-free progress restart an idle task", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
  });

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
