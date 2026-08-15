import { describe, expect, it } from "vite-plus/test";

import {
  applyGrokSubagentUpdate,
  applyGrokWorkflowUpdate,
  emptyGrokWorkflowTrackState,
  grokWorkflowMemberTaskId,
  parseXAiSubagentUpdate,
  parseXAiWorkflowUpdated,
} from "./GrokAcpWorkflow.ts";

const workflowEnvelope = {
  sessionId: "sess-1",
  update: {
    sessionUpdate: "workflow_updated",
    run_id: "wf_review_1",
    name: "review-changes",
    objective: "Review the latest diff",
    status: "active",
    phases: [
      { title: "Plan", state: "done" },
      { title: "Execute", state: "active" },
    ],
    current_phase: "Execute",
    agents: [
      {
        agent_id: "agent_reviewer",
        label: "Reviewer",
        state: "running",
        tokens_used: 42,
        duration_ms: 800,
      },
    ],
  },
};

describe("GrokAcpWorkflow", () => {
  it("stamps workflow members like Claude: parentAgentId + timelineBypass + stable slot", () => {
    const update = parseXAiWorkflowUpdated(workflowEnvelope);
    expect(update).toBeDefined();
    const first = applyGrokWorkflowUpdate(emptyGrokWorkflowTrackState(), update!);
    const memberStarted = first.events.find(
      (event) => event.type === "task.started" && event.payload.taskType === "subagent",
    );
    expect(memberStarted?.payload).toMatchObject({
      taskId: grokWorkflowMemberTaskId("wf_review_1", 0),
      parentAgentId: "wf_review_1",
      timelineBypass: true,
    });
    expect(memberStarted?.payload.agentId).toBeUndefined();
    expect(first.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
  });

  it("completes a run that is already terminal on the first notification", () => {
    const update = parseXAiWorkflowUpdated({
      update: {
        sessionUpdate: "workflow_updated",
        run_id: "wf_done",
        name: "review-changes",
        status: "complete",
        result_summary: "Shipped",
        phases: [],
        agents: [],
      },
    });
    const applied = applyGrokWorkflowUpdate(emptyGrokWorkflowTrackState(), update!);
    expect(applied.events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(applied.events[1]?.payload).toMatchObject({ status: "completed", summary: "Shipped" });
  });

  it("does not re-emit unchanged member ticks", () => {
    const update = parseXAiWorkflowUpdated(workflowEnvelope)!;
    const first = applyGrokWorkflowUpdate(emptyGrokWorkflowTrackState(), update);
    const second = applyGrokWorkflowUpdate(first.state, update);
    expect(second.events.some((event) => event.payload.taskType === "subagent")).toBe(false);
  });

  it("maps SubagentFinished onto a terminal child task", () => {
    const spawned = parseXAiSubagentUpdate({
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "sa_1",
        parent_session_id: "sess-1",
        child_session_id: "child-1",
        subagent_type: "explore",
      },
    });
    const finished = parseXAiSubagentUpdate({
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: "sa_1",
        child_session_id: "child-1",
        status: "completed",
        tokens_used: 90,
      },
    });
    const afterSpawn = applyGrokSubagentUpdate(emptyGrokWorkflowTrackState(), spawned!);
    const afterFinish = applyGrokSubagentUpdate(afterSpawn.state, finished!);
    expect(afterSpawn.events[0]).toMatchObject({
      type: "task.started",
      payload: { timelineBypass: true, role: "explore", parentAgentId: "sess-1" },
    });
    expect(afterFinish.events[0]).toMatchObject({
      type: "task.completed",
      payload: { status: "completed", typedUsage: { totalTokens: 90 } },
    });
  });
});
