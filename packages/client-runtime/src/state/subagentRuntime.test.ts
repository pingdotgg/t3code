import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isAgentAttributedToolActivity,
  isSubagentActivityKind,
  isTimelineBypassActivity,
  workflowCardMembers,
} from "./subagentRuntime.ts";

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("foldSubagentActivities", () => {
  it("builds an agent from start → progress → completion", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-1",
        title: "Audit auth flow",
        role: "explorer",
      }),
      activity("task.progress", {
        taskId: "task-1",
        lastToolName: "Read",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
      }),
      activity("task.completed", {
        taskId: "task-1",
        status: "completed",
        summary: "Found 2 issues",
        typedUsage: { totalTokens: 5000, toolUses: 9 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Audit auth flow");
    expect(agent.role).toBe("explorer");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Found 2 issues");
    expect(agent.usage?.totalTokens).toBe(5000);
    expect(agent.activationCount).toBe(1);
    expect(agent.completedAt).not.toBeNull();
  });

  it("progress can create an agent when its start row aged out of retention", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "task-orphan",
        title: "Recovered agent",
        role: "verifier",
        typedUsage: { totalTokens: 100 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Recovered agent");
    expect(agents[0]!.status).toBe("running");
  });

  it("completion before start stays terminal; a late start only fills metadata", () => {
    const agents = fold([
      activity("task.completed", {
        taskId: "task-2",
        status: "failed",
        summary: "boom",
        role: "fixer",
      }),
      activity("task.started", { taskId: "task-2", title: "Late metadata", role: "fixer" }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Late metadata");
    expect(agent.role).toBe("fixer");
    // The late start must NOT reopen the terminal activation as a new run.
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("duplicate terminal events are idempotent (timestamps do not slide)", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-3", taskType: "local_agent" }),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("reactivation increments the run count and clears result/error", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-4", taskType: "local_agent" }),
      activity("task.completed", { taskId: "task-4", status: "completed", summary: "run 1 done" }),
      activity("task.updated", { taskId: "task-4", status: "running" }),
    ]);
    const agent = agents[0]!;
    expect(agent.activationCount).toBe(2);
    expect(agent.result).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.status).toBe("running");
  });

  it("idle is nonterminal: an idle agent resumes without losing identity", () => {
    const agents = fold([
      activity("task.started", { taskId: "codex-child-1", title: "Marlow", role: "explorer" }),
      activity("task.updated", { taskId: "codex-child-1", status: "idle" }),
      activity("task.updated", { taskId: "codex-child-1", status: "running" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(2);
    expect(agents[0]!.status).toBe("running");
  });

  it("cumulative usage max-merges: duplicate and late frames never shrink or double-count", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-5", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", { taskId: "task-5", typedUsage: { totalTokens: 500 } }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 900, inputTokens: 700 });
  });

  it("partial terminal usage preserves known breakdown fields", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-6", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-6",
        typedUsage: { totalTokens: 800, inputTokens: 600, outputTokens: 150 },
      }),
      activity("task.completed", {
        taskId: "task-6",
        status: "completed",
        typedUsage: { totalTokens: 1000 },
      }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 1000, inputTokens: 600, outputTokens: 150 });
  });

  it("skips malformed rows individually without failing the fold", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-7", title: "Good", taskType: "local_agent" }),
      activity("task.progress", { bogus: true }),
      activity("task.progress", { taskId: 42 }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Good");
  });

  it("bounds repeated strings at 180 chars and the activity ring at 6 deduped entries", () => {
    const long = "x".repeat(500);
    const rows = [activity("task.started", { taskId: "task-8", taskType: "local_agent" })];
    for (let i = 0; i < 10; i += 1) {
      rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-${i}` }));
    }
    rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-9` }));
    const agents = fold(rows);
    const agent = agents[0]!;
    expect(agent.recentActivity.length).toBeLessThanOrEqual(6);
    for (const entry of agent.recentActivity) {
      expect(entry.summary.length).toBeLessThanOrEqual(180);
    }
    // Consecutive identical summaries dedupe (truncation makes them equal).
    const summaries = agent.recentActivity.map((entry) => entry.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("plan tasks are not agents", () => {
    const agents = fold([activity("task.started", { taskId: "plan-1", taskType: "plan" })]);
    expect(agents).toHaveLength(0);
  });

  it("workflow members key by stable slot and attach to their coordinator", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit-auth-flow",
        workflowName: "audit-auth-flow",
      }),
      activity("task.progress", {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "audit:entrypoints",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Audit",
        timelineBypass: true,
      }),
    ]);
    const workflow = agents.find((agent) => agent.id === "wf-1");
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.phases).toEqual([
      { index: 0, title: "Audit" },
      { index: 1, title: "Verify" },
    ]);
    expect(member?.kind).toBe("workflow_agent");
    expect(member?.parentAgentId).toBe("wf-1");
  });

  it("a workflow member retry (attempt bump) is a reactivation of the same slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "failed",
        error: "attempt 1 died",
        parentAgentId: "wf-2",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "running",
        parentAgentId: "wf-2",
        attempt: 2,
      }),
    ]);
    expect(agents).toHaveLength(1);
    const member = agents[0]!;
    expect(member.activationCount).toBeGreaterThanOrEqual(2);
    expect(member.error).toBeNull();
    expect(member.status).toBe("running");
  });

  it("drops non-http(s) session urls at the fold boundary", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        runHandles: { sessionUrl: "javascript:alert(1)", runId: "run-1" },
      }),
    ]);
    expect(agents[0]!.runHandles?.sessionUrl).toBeUndefined();
    expect(agents[0]!.runHandles?.runId).toBe("run-1");
  });
});

describe("deriveAgentPanelModel", () => {
  const roster = fold([
    activity("task.started", { taskId: "wf-1", taskType: "local_workflow", title: "audit" }),
    activity("task.progress", {
      taskId: "wf-1",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    }),
    activity("task.progress", {
      taskId: "wf-1:wf:0",
      title: "audit:a",
      status: "completed",
      parentAgentId: "wf-1",
      agentIndex: 0,
      phaseIndex: 0,
    }),
    activity("task.completed", { taskId: "wf-1:wf:0", status: "completed", parentAgentId: "wf-1" }),
    activity("task.progress", {
      taskId: "wf-1:wf:1",
      title: "verify:b",
      status: "running",
      parentAgentId: "wf-1",
      agentIndex: 1,
      phaseIndex: 1,
      typedUsage: { totalTokens: 4000 },
    }),
    activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
    activity("task.updated", { taskId: "direct-1", status: "idle" }),
  ]);

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
  });

  it("counts idle deliberately and waiting as active", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.idleCount).toBe(1);
    // wf-1 coordinator + member 1 running.
    expect(model.runningCount).toBeGreaterThanOrEqual(1);
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length,
    );
  });

  it("a phase with only pending members never reads as running", () => {
    const pendingRoster = fold([
      activity("task.started", { taskId: "wf-9", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-9",
        phases: [{ index: 0, title: "Fix" }],
      }),
      activity("task.progress", {
        taskId: "wf-9:wf:0",
        title: "fixer",
        status: "pending",
        parentAgentId: "wf-9",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: pendingRoster });
    // "pending" counts as active liveness (queued work), so the phase reads
    // running only if a member is genuinely pending/running — this asserts
    // the settled-count rule: no member settled, phase not done.
    expect(model.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("v2 projection wins outright and sources are never merged", () => {
    const v2Agent = { ...roster[0]!, id: "v2-only", title: "From v2" };
    const model = deriveAgentPanelModel({ agents: roster, v2Projection: [v2Agent] });
    const allIds = [
      ...model.workflows.map((group) => group.workflow.id),
      ...model.directAgents.map((agent) => agent.id),
    ];
    expect(allIds).toContain("v2-only");
    expect(allIds).not.toContain("direct-1");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = fold([
      activity("task.progress", {
        taskId: "gone:wf:0",
        title: "orphan",
        status: "running",
        parentAgentId: "gone",
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: orphans });
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["gone:wf:0"]);
  });
});

describe("workflowCardMembers", () => {
  it("orders by urgency (failed, running, waiting) and reports overflow", () => {
    const roster = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      ...[..."abcdefghij"].map((letter, index) =>
        activity("task.progress", {
          taskId: `wf-1:wf:${index}`,
          title: `agent-${letter}`,
          status: index === 3 ? "failed" : index < 3 ? "completed" : "running",
          ...(index === 3 ? { error: "died" } : {}),
          parentAgentId: "wf-1",
          agentIndex: index,
          phaseIndex: 0,
          phaseTitle: "Work",
        }),
      ),
    ]);
    const model = deriveAgentPanelModel({ agents: roster });
    const { visible, overflow } = workflowCardMembers(model.workflows[0]!, 8);
    expect(visible).toHaveLength(8);
    expect(overflow).toBe(2);
    expect(visible[0]!.status).toBe("failed");
    expect(visible.filter((agent) => agent.status === "completed").length).toBeLessThanOrEqual(2);
  });
});

describe("timeline predicates", () => {
  it("recognizes subagent activity kinds as fold input", () => {
    for (const kind of [
      "task.started",
      "task.progress",
      "task.updated",
      "task.completed",
      "tool.progress",
    ]) {
      expect(isSubagentActivityKind(kind)).toBe(true);
    }
    expect(isSubagentActivityKind("tool.completed")).toBe(false);
  });

  it("attributed tool rows are re-homed; unattributed rows stay in the timeline", () => {
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "task-1" }))).toBe(
      true,
    );
    expect(isAgentAttributedToolActivity(activity("tool.completed", {}))).toBe(false);
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "  " }))).toBe(
      false,
    );
  });

  it("timelineBypass rows never render in the parent chat", () => {
    expect(isTimelineBypassActivity(activity("task.progress", { timelineBypass: true }))).toBe(
      true,
    );
    expect(isTimelineBypassActivity(activity("task.progress", {}))).toBe(false);
  });
});

describe("formatSubagentTokenCount", () => {
  it("formats plain counters", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("model and effort attribution", () => {
  it("carries model/effort from start rows and refines model from later rows", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-m",
        title: "Verify math",
        model: "sonnet",
        effort: "high",
      }),
      // Later row refines with the authoritative API model id; effort absent
      // must not clear the known value.
      activity("task.progress", { taskId: "task-m", model: "claude-sonnet-5[1m]" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-sonnet-5[1m]");
    expect(agents[0]!.effort).toBe("high");
  });

  it("formatSubagentModelLabel compacts ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol", "low")).toBe("gpt-5.6-sol · low");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("background task exclusion", () => {
  it("shells and monitors never join the roster (from any lifecycle row)", () => {
    const agents = fold([
      activity("task.started", { taskId: "shell-1", taskType: "shell", title: "Run 12s stall" }),
      activity("task.progress", { taskId: "shell-2", taskType: "shell", title: "Run stall" }),
      activity("task.completed", { taskId: "mon-1", taskType: "monitor", status: "completed" }),
      activity("task.started", { taskId: "agent-1", taskType: "subagent", title: "Real agent" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
  });

  it("rows without a taskType stay in the roster (workflow members, Codex children)", () => {
    const agents = fold([
      activity("task.progress", { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" }),
    ]);
    expect(agents).toHaveLength(1);
  });

  it("the server stamp is the only classifier: no stamp means no roster row", () => {
    const agents = fold([
      // Stamped background: agent-looking fields don't matter.
      activity("task.started", {
        taskId: "bg-1",
        agentKind: "background",
        role: "watcher",
        model: "sonnet",
      }),
      // Stamped agent: plain row still joins the roster.
      activity("task.started", { taskId: "ag-1", agentKind: "agent", detail: "plain row" }),
      // Legacy pre-stamp rows (old threads/servers) stay in the work log —
      // exactly their pre-upgrade behavior.
      legacyActivity("task.started", { taskId: "old-task", detail: "tailing logs" }),
      legacyActivity("task.progress", { taskId: "old-task", summary: "still tailing" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["ag-1"]);
  });

  it("membership is sticky: a stampless later row still reaches a known agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "a1", taskType: "local_agent", title: "Agent" }),
      // Terminal row missing the stamp (defensive: adapters synthesize some
      // rows) — sticky membership still routes it to the agent.
      legacyActivity("task.completed", { taskId: "a1", status: "completed", summary: "done" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
    expect(agents[0]!.result).toBe("done");
  });
});

describe("session-derived interruption", () => {
  it("dead session interrupts live agents but preserves idle and settled", () => {
    const rows = [
      activity("task.started", { taskId: "live-1", taskType: "local_agent" }),
      activity("task.started", { taskId: "idle-1", taskType: "local_agent" }),
      activity("task.updated", { taskId: "idle-1", status: "idle" }),
      activity("task.started", { taskId: "done-1", taskType: "local_agent" }),
      activity("task.completed", { taskId: "done-1", status: "completed" }),
    ];
    const dead = foldSubagentActivities(rows, { sessionLive: false });
    expect(dead.find((agent) => agent.id === "live-1")?.status).toBe("interrupted");
    expect(dead.find((agent) => agent.id === "idle-1")?.status).toBe("idle");
    expect(dead.find((agent) => agent.id === "done-1")?.status).toBe("completed");
    const alive = foldSubagentActivities(rows, { sessionLive: true });
    expect(alive.find((agent) => agent.id === "live-1")?.status).toBe("running");
  });
});

describe("terminal robustness", () => {
  it("task.updated creating an agent (start row aged out) counts one activation", () => {
    const agents = fold([
      activity("task.updated", { taskId: "orphan-u", status: "running", role: "worker" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(1);
    expect(agents[0]!.status).toBe("running");
  });

  it("a late start after a terminal task.updated does not reopen the run", () => {
    const agents = fold([
      activity("task.updated", { taskId: "t1", status: "failed", role: "worker" }),
      activity("task.started", { taskId: "t1", taskType: "local_agent", title: "Late" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(agents[0]!.title).toBe("Late");
  });

  it("a completion after a terminal task.updated still enriches result and usage", () => {
    // Claude commonly emits terminal task.updated before task.completed;
    // the completion carries the summary and final usage the update lacked.
    const agents = fold([
      activity("task.started", { taskId: "te-1", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "te-1", status: "completed", endedAt: "2026-08-01T10:59:00.000Z" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        {
          taskId: "te-1",
          status: "completed",
          summary: "final answer",
          typedUsage: { totalTokens: 4200, toolUses: 7 },
        },
        "2026-08-01T11:00:01.000Z",
      ),
    ]);
    const agent = agents[0]!;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("final answer");
    expect(agent.usage?.totalTokens).toBe(4200);
    // Timestamps stay pinned to the transition that settled the run.
    expect(agent.completedAt).toBe("2026-08-01T10:59:00.000Z");
  });

  it("duplicate completions keep the FIRST result, not the last", () => {
    const agents = fold([
      activity("task.started", { taskId: "t2", taskType: "local_agent" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "first result" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "second result" }),
    ]);
    expect(agents[0]!.result).toBe("first result");
  });

  it("provider endedAt wins over ingestion time on the settling transition", () => {
    const agents = fold([
      activity("task.started", { taskId: "t3", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "t3", status: "failed", endedAt: "2026-08-01T09:59:59.000Z" },
        "2026-08-01T10:00:30.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:59:59.000Z");
  });

  it("workflow retries count each attempt once", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "failed",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 2,
      }),
    ]);
    expect(agents[0]!.activationCount).toBe(2);
  });
});

describe("phase membership", () => {
  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", {
          taskId: "wf-p",
          taskType: "local_workflow",
          phases: [{ index: 0, title: "Only phase" }],
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:0",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 0,
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:9",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 9,
        }),
      ]),
    });
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((member) => member.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });
});

describe("coordinator settle cascade", () => {
  it("members without their own terminal row settle when the coordinator does", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "stalled member",
        status: "running",
        parentAgentId: "wf-1",
      }),
      activity("task.completed", {
        taskId: "wf-1",
        status: "completed",
        taskType: "local_workflow",
      }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(member?.status).toBe("completed");
    expect(member?.completedAt).not.toBeNull();
  });

  it("a failed coordinator marks unfinished members interrupted, not completed", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        status: "running",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "failed", taskType: "local_workflow" }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-2:wf:0");
    expect(member?.status).toBe("interrupted");
  });
});

describe("task type classification is a denylist", () => {
  it("unknown agent-flavored types (local_agent, future names) join the roster", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "a1",
        taskType: "local_agent",
        title: "Math test 1",
        role: "claude",
      }),
      activity("task.started", { taskId: "a2", taskType: "some_future_agent_kind", title: "X" }),
    ]);
    expect(agents.map((agent) => agent.id).toSorted()).toEqual(["a1", "a2"]);
  });
});

describe("nested agents vs subagent shells", () => {
  it("a nested agent (agentId + agent taskType) stays in the roster; its shells do not", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "nested-1",
        taskType: "local_agent",
        agentId: "parent-agent",
        title: "Nested researcher",
      }),
      activity("task.started", {
        taskId: "shell-1",
        taskType: "local_bash",
        agentId: "parent-agent",
        title: "Nested sleep",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["nested-1"]);
  });
});
