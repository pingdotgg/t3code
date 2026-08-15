import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveMobileAgentDetailModel,
  deriveMobileAgentPanelModel,
  deriveMobileAgentRowModel,
  findMobileAgent,
} from "./agentPresentation";

function activity(
  id: string,
  kind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown>,
  second: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "info",
    summary: kind,
    payload: { agentKind: "agent", ...payload },
    turnId: TurnId.make("turn-agents"),
    sequence: second,
    createdAt: new Date(Date.parse("2026-08-14T12:00:00.000Z") + second * 1_000).toISOString(),
  };
}

describe("mobile Agents presentation", () => {
  it("derives workflow phases and compact per-agent metadata from the shared fold", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity(
          "workflow-start",
          "task.started",
          {
            taskId: "workflow-1",
            taskType: "local_workflow",
            workflowName: "Review rollout",
            phases: [
              { index: 0, title: "Audit" },
              { index: 1, title: "Verify" },
            ],
          },
          1,
        ),
        activity(
          "workflow-member",
          "task.progress",
          {
            taskId: "workflow-1:wf:0",
            parentAgentId: "workflow-1",
            phaseIndex: 0,
            phaseTitle: "Audit",
            agentIndex: 0,
            status: "completed",
            title: "Check auth",
            role: "explorer",
            model: "claude-sonnet-5[1m]",
            effort: "high",
            summary: "Mapped entry points",
            typedUsage: { totalTokens: 4_200, toolUses: 7 },
          },
          2,
        ),
        activity(
          "direct-start",
          "task.started",
          { taskId: "direct-1", title: "Verify tests", role: "worker" },
          3,
        ),
      ],
    });

    expect(model.workflows).toHaveLength(1);
    expect(model.workflows[0]?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Audit", "done"],
      ["Verify", "pending"],
    ]);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
    expect(
      deriveMobileAgentRowModel(model.directAgents[0]!, Date.parse("2026-08-14T12:01:00.000Z"))
        .tokenLabel,
    ).toBe("— tok");

    const member = model.workflows[0]?.phases[0]?.members[0];
    expect(
      member && deriveMobileAgentRowModel(member, Date.parse("2026-08-14T12:01:00.000Z")),
    ).toMatchObject({
      title: "Check auth",
      role: "explorer",
      modelLabel: "sonnet-5[1m] · high",
      statusLabel: "Completed",
      activity: "Mapped entry points",
      tokenLabel: "4.2k tok",
      toolLabel: "7 tools",
    });
  });

  it("keeps an empty model informative", () => {
    const model = deriveMobileAgentPanelModel({ activities: [], sessionLive: false });
    expect(model).toMatchObject({ hasAgents: false, liveCount: 0, totalTokens: 0 });
  });

  it("formats live-agent elapsed time at minute and hour scales", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [activity("elapsed-start", "task.started", { taskId: "elapsed-agent" }, 1)],
    });
    const agent = model.directAgents[0]!;

    expect(deriveMobileAgentRowModel(agent, Date.parse("2026-08-14T12:01:06.000Z")).elapsed).toBe(
      "1m 05s",
    );
    expect(deriveMobileAgentRowModel(agent, Date.parse("2026-08-14T13:03:01.000Z")).elapsed).toBe(
      "1h 03m",
    );
  });

  it("freezes idle-agent elapsed time at its last activity", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity("idle-start", "task.started", { taskId: "idle-agent" }, 1),
        activity("idle-update", "task.updated", { taskId: "idle-agent", status: "idle" }, 7),
      ],
    });
    const agent = model.directAgents[0]!;

    expect(deriveMobileAgentRowModel(agent, Date.parse("2026-08-14T12:01:00.000Z")).elapsed).toBe(
      "6s",
    );
    expect(deriveMobileAgentRowModel(agent, Date.parse("2026-08-15T12:01:00.000Z")).elapsed).toBe(
      "6s",
    );
  });

  it("keeps a 150-member workflow roster, counts, and detail lookup consistent", () => {
    const workflowId = "large-workflow";
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity(
          "large-workflow-start",
          "task.started",
          { taskId: workflowId, taskType: "local_workflow", workflowName: "Large audit" },
          1,
        ),
        ...Array.from({ length: 150 }, (_, index) =>
          activity(
            `large-workflow-member-${index}`,
            "task.progress",
            {
              taskId: `${workflowId}:wf:${index}`,
              parentAgentId: workflowId,
              agentIndex: index,
              status: "running",
              summary: `Member ${index} working`,
            },
            index + 2,
          ),
        ),
      ],
    });

    const members = model.workflows[0]?.unphasedMembers ?? [];
    expect(members).toHaveLength(150);
    // Upstream #6672: the workflow coordinator is no longer counted as a working agent.
    expect(model.liveCount).toBe(150);
    const targetId = `${workflowId}:wf:149`;
    const target = findMobileAgent(model, targetId);
    expect(target?.id).toBe(targetId);
    expect(target && deriveMobileAgentDetailModel(target)).toMatchObject({
      id: targetId,
      statusLabel: "Working",
      activity: "Member 149 working",
    });
  });

  it("derives running detail with role, model, elapsed time, usage, and activity", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity(
          "running-start",
          "task.started",
          { taskId: "running-agent", role: "explorer", model: "gpt-5.6" },
          1,
        ),
        activity(
          "running-progress",
          "task.progress",
          {
            taskId: "running-agent",
            summary: "Tracing the provider boundary",
            typedUsage: { totalTokens: 2_500, toolUses: 4 },
          },
          2,
        ),
      ],
    });

    expect(
      deriveMobileAgentDetailModel(model.directAgents[0]!, Date.parse("2026-08-14T12:01:01.000Z")),
    ).toMatchObject({
      statusLabel: "Working",
      role: "explorer",
      modelLabel: "gpt-5.6",
      elapsed: "1m 00s",
      tokenLabel: "2.5k tok",
      toolLabel: "4 tools",
      result: null,
      error: null,
      activities: [{ summary: "Tracing the provider boundary" }],
      activityTruncationLabel: null,
    });
  });

  it("derives settled detail with the result", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity("settled-start", "task.started", { taskId: "settled-agent" }, 1),
        activity(
          "settled-complete",
          "task.completed",
          { taskId: "settled-agent", status: "completed", summary: "Audit complete" },
          7,
        ),
      ],
    });

    expect(deriveMobileAgentDetailModel(model.directAgents[0]!)).toMatchObject({
      statusLabel: "Completed",
      elapsed: "6s",
      result: "Audit complete",
      error: null,
    });
  });

  it("derives failed detail with the provider error", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity("failed-start", "task.started", { taskId: "failed-agent" }, 1),
        activity(
          "failed-update",
          "task.updated",
          { taskId: "failed-agent", status: "failed", error: "Permission denied" },
          5,
        ),
      ],
    });

    expect(deriveMobileAgentDetailModel(model.directAgents[0]!)).toMatchObject({
      statusLabel: "Failed",
      result: null,
      error: "Permission denied",
    });
  });

  it("notes when the fold dropped older activity ring entries", () => {
    const model = deriveMobileAgentPanelModel({
      sessionLive: true,
      activities: [
        activity("truncated-start", "task.started", { taskId: "truncated-agent" }, 1),
        ...Array.from({ length: 8 }, (_, index) =>
          activity(
            `truncated-progress-${index}`,
            "task.progress",
            { taskId: "truncated-agent", summary: `Step ${index + 1}` },
            index + 2,
          ),
        ),
      ],
    });
    const detail = deriveMobileAgentDetailModel(model.directAgents[0]!);

    expect(detail.activities).toHaveLength(6);
    expect(detail.activities.map((entry) => entry.summary)).toEqual([
      "Step 3",
      "Step 4",
      "Step 5",
      "Step 6",
      "Step 7",
      "Step 8",
    ]);
    expect(detail.activities.map((entry) => entry.id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `truncated-progress-${index + 2}`),
    );
    expect(detail.activityTruncationLabel).toBe(
      "Showing the latest 6 activities; earlier entries were dropped.",
    );
  });
});
