import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  applyAgentPanelClearedAt,
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  hasClearableAgents,
  latestAgentActivityAt,
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

  it("usage snapshots enrich an existing agent without changing its status", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "usage-waiting", taskType: "local_agent" }),
      activity("task.progress", { taskId: "usage-waiting", status: "waiting" }),
      activity("task.progress", {
        taskId: "usage-waiting",
        usageSnapshot: true,
        typedUsage: { totalTokens: 1_200 },
      }),
    ]);

    expect(agent?.status).toBe("waiting");
    expect(agent?.usage?.totalTokens).toBe(1_200);
  });

  it("a retained usage snapshot can still reconstruct a running agent", () => {
    const [agent] = fold([
      activity("task.progress", {
        taskId: "usage-only",
        usageSnapshot: true,
        typedUsage: { totalTokens: 800 },
      }),
    ]);

    expect(agent?.status).toBe("running");
    expect(agent?.usage?.totalTokens).toBe(800);
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

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = fold([
      activity("task.started", { taskId: "direct-a", title: "First" }, "2026-08-01T11:00:00.000Z"),
      activity("task.started", { taskId: "direct-b", title: "Second" }, "2026-08-01T11:00:01.000Z"),
      activity(
        "task.progress",
        { taskId: "direct-a", summary: "Newest activity" },
        "2026-08-01T11:00:02.000Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: directRoster }).directAgents.map((agent) => agent.id),
    ).toEqual(["direct-a", "direct-b"]);
  });

  it("keeps first-seen order after the roster retention ranking runs", () => {
    const starts = Array.from({ length: 101 }, (_, index) =>
      activity(
        "task.started",
        { taskId: `capped-${index}`, title: `Agent ${index}` },
        `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
      ),
    );
    const cappedRoster = fold([
      ...starts,
      activity(
        "task.progress",
        { taskId: "capped-0", summary: "Newest activity" },
        "2026-08-01T12:02:00.000Z",
      ),
    ]);

    const ids = deriveAgentPanelModel({ agents: cappedRoster }).directAgents.map(
      (agent) => agent.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(["capped-0", "capped-2", "capped-3"]);
    expect(ids.at(-1)).toBe("capped-100");
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

describe("cleared agent panel models", () => {
  const cutoff = "2026-08-02T00:00:00.000Z";

  it("hides old inactive direct agents — idle included — while retaining working and newer rows with recalculated totals", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "old-completed", taskType: "local_agent" },
          "2026-08-01T08:00:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "old-completed", status: "completed", typedUsage: { totalTokens: 1 } },
          "2026-08-01T08:01:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "old-failed", taskType: "local_agent" },
          "2026-08-01T08:02:00.000Z",
        ),
        activity(
          "task.updated",
          { taskId: "old-failed", status: "failed" },
          "2026-08-01T08:03:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "old-cancelled", taskType: "local_agent" },
          "2026-08-01T08:04:00.000Z",
        ),
        activity(
          "task.updated",
          { taskId: "old-cancelled", status: "cancelled" },
          "2026-08-01T08:05:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "old-interrupted", taskType: "local_agent" },
          "2026-08-01T08:06:00.000Z",
        ),
        activity(
          "task.updated",
          { taskId: "old-interrupted", status: "interrupted" },
          "2026-08-01T08:07:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "running", taskType: "local_agent", typedUsage: { totalTokens: 5 } },
          "2026-08-01T08:08:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "running", status: "running", typedUsage: { totalTokens: 5 } },
          "2026-08-01T08:09:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "pending", taskType: "local_agent", typedUsage: { totalTokens: 6 } },
          "2026-08-01T08:10:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "pending", status: "pending", typedUsage: { totalTokens: 6 } },
          "2026-08-01T08:11:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "waiting", taskType: "local_agent", typedUsage: { totalTokens: 7 } },
          "2026-08-01T08:12:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "waiting", status: "waiting", typedUsage: { totalTokens: 7 } },
          "2026-08-01T08:13:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "idle", taskType: "local_agent", typedUsage: { totalTokens: 8 } },
          "2026-08-01T08:14:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "idle", status: "idle", typedUsage: { totalTokens: 8 } },
          "2026-08-01T08:15:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "reactivated", taskType: "local_agent", typedUsage: { totalTokens: 9 } },
          "2026-08-01T08:16:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "reactivated", status: "completed" },
          "2026-08-01T08:17:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "reactivated", status: "running", typedUsage: { totalTokens: 9 } },
          "2026-08-03T08:18:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "newly-completed", taskType: "local_agent", typedUsage: { totalTokens: 10 } },
          "2026-08-01T08:19:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "newly-completed", status: "completed", typedUsage: { totalTokens: 10 } },
          "2026-08-03T08:20:00.000Z",
        ),
      ]),
    });

    const { model: visible, hiddenCount } = applyAgentPanelClearedAt(model, cutoff);

    expect(visible.directAgents.map((agent) => agent.id)).toEqual([
      "running",
      "pending",
      "waiting",
      "reactivated",
      "newly-completed",
    ]);
    expect(hiddenCount).toBe(5);
    expect(visible.runningCount).toBe(3);
    expect(visible.waitingCount).toBe(1);
    expect(visible.idleCount).toBe(0);
    expect(visible.settledCount).toBe(1);
    expect(visible.totalTokens).toBe(37);
    // newly-completed postdates the cutoff, so a second clear still has work.
    expect(hasClearableAgents(visible)).toBe(true);
  });

  it("fails open for an invalid cutoff and clears rows with an undateable timestamp", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "old", taskType: "local_agent" },
          "2026-08-01T09:00:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "old", status: "completed" },
          "2026-08-01T09:01:00.000Z",
        ),
      ]),
    });
    const undateableModel = deriveAgentPanelModel({
      agents: [{ ...model.directAgents[0]!, updatedAt: "not-a-timestamp" }],
    });

    // A bad cutoff leaves the model untouched, by reference.
    expect(applyAgentPanelClearedAt(model, "not-a-timestamp").model).toBe(model);
    expect(applyAgentPanelClearedAt(model, "not-a-timestamp").hiddenCount).toBe(0);
    expect(applyAgentPanelClearedAt(model, null).model).toBe(model);
    // A row we cannot date is still inactive: clear it rather than latch the
    // affordance on forever.
    expect(applyAgentPanelClearedAt(undateableModel, cutoff).model.hasAgents).toBe(false);
    expect(applyAgentPanelClearedAt(undateableModel, cutoff).hiddenCount).toBe(1);
  });

  it("returns the same model reference when the cutoff hides nothing", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "live", taskType: "local_agent" },
          "2026-08-01T09:00:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "live", status: "running" },
          "2026-08-01T09:01:00.000Z",
        ),
      ]),
    });

    const cleared = applyAgentPanelClearedAt(model, cutoff);

    expect(cleared.model).toBe(model);
    expect(cleared.hiddenCount).toBe(0);
  });

  it("treats every non-working status as clearable and keeps workflows atomic", () => {
    const directModel = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "old-direct", taskType: "local_agent" },
          "2026-08-01T09:10:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "old-direct", status: "completed" },
          "2026-08-01T09:11:00.000Z",
        ),
      ]),
    });
    const idleDirectModel = deriveAgentPanelModel({
      agents: [{ ...directModel.directAgents[0]!, status: "idle" }],
    });
    const runningDirectModel = deriveAgentPanelModel({
      agents: [{ ...directModel.directAgents[0]!, status: "running" }],
    });
    const waitingDirectModel = deriveAgentPanelModel({
      agents: [{ ...directModel.directAgents[0]!, status: "waiting" }],
    });
    const workflowModel = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "old-workflow", taskType: "local_workflow" },
          "2026-08-01T09:20:00.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "old-workflow:member", parentAgentId: "old-workflow", status: "completed" },
          "2026-08-01T09:21:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "old-workflow", taskType: "local_workflow", status: "completed" },
          "2026-08-01T09:22:00.000Z",
        ),
      ]),
    });
    const workflow = workflowModel.workflows[0]!;
    const idleMemberWorkflowModel = deriveAgentPanelModel({
      agents: [workflow.workflow, { ...workflow.unphasedMembers[0]!, status: "idle" }],
    });
    const runningMemberWorkflowModel = deriveAgentPanelModel({
      agents: [workflow.workflow, { ...workflow.unphasedMembers[0]!, status: "running" }],
    });

    expect(hasClearableAgents(directModel)).toBe(true);
    // The regression this fixes: a resting Codex child used to be unclearable.
    expect(hasClearableAgents(idleDirectModel)).toBe(true);
    expect(hasClearableAgents(runningDirectModel)).toBe(false);
    expect(hasClearableAgents(waitingDirectModel)).toBe(false);
    expect(hasClearableAgents(workflowModel)).toBe(true);
    expect(hasClearableAgents(idleMemberWorkflowModel)).toBe(true);
    // One working member pins the whole group.
    expect(hasClearableAgents(runningMemberWorkflowModel)).toBe(false);
    // Offset-form cutoffs parse the same as Z-form.
    expect(applyAgentPanelClearedAt(directModel, "2026-08-02T00:00:00+00:00").hiddenCount).toBe(1);
  });

  it("preserves a working workflow atomically and hides a fully inactive old workflow", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity(
          "task.started",
          { taskId: "active-workflow", taskType: "local_workflow" },
          "2026-08-01T10:00:00.000Z",
        ),
        activity(
          "task.progress",
          {
            taskId: "active-workflow:old-member",
            parentAgentId: "active-workflow",
            status: "completed",
            typedUsage: { totalTokens: 11 },
          },
          "2026-08-01T10:01:00.000Z",
        ),
        activity(
          "task.progress",
          {
            taskId: "active-workflow:running-member",
            parentAgentId: "active-workflow",
            status: "running",
            typedUsage: { totalTokens: 12 },
          },
          "2026-08-03T10:02:00.000Z",
        ),
        activity(
          "task.started",
          { taskId: "settled-workflow", taskType: "local_workflow" },
          "2026-08-01T10:03:00.000Z",
        ),
        activity(
          "task.progress",
          {
            taskId: "settled-workflow:member",
            parentAgentId: "settled-workflow",
            status: "completed",
            typedUsage: { totalTokens: 13 },
          },
          "2026-08-01T10:04:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "settled-workflow", taskType: "local_workflow", status: "completed" },
          "2026-08-01T10:05:00.000Z",
        ),
      ]),
    });

    const { model: visible, hiddenCount } = applyAgentPanelClearedAt(model, cutoff);
    const active = visible.workflows[0]!;

    expect(visible.workflows.map((group) => group.workflow.id)).toEqual(["active-workflow"]);
    expect(active.workflow.id).toBe("active-workflow");
    // The settled member rides along: its group still has work in flight.
    expect(
      [...active.phases.flatMap((phase) => phase.members), ...active.unphasedMembers].map(
        (member) => member.id,
      ),
    ).toEqual(["active-workflow:old-member", "active-workflow:running-member"]);
    expect(hiddenCount).toBe(2);
    expect(hasClearableAgents(model)).toBe(true);
    expect(hasClearableAgents(visible)).toBe(false);
  });

  it("advances updatedAt when a late completion enriches an already-terminal row", () => {
    const [agent] = fold([
      activity(
        "task.started",
        { taskId: "late", taskType: "local_agent" },
        "2026-08-01T09:00:00.000Z",
      ),
      activity("task.updated", { taskId: "late", status: "completed" }, "2026-08-01T09:01:00.000Z"),
      activity(
        "task.completed",
        { taskId: "late", status: "completed", summary: "done", typedUsage: { totalTokens: 4 } },
        "2026-08-03T09:02:00.000Z",
      ),
    ]);

    expect(agent!.result).toBe("done");
    // Frozen: the enrichment is not a transition.
    expect(agent!.completedAt).toBe("2026-08-01T09:01:00.000Z");
    // Advanced: a row cleared before its result landed must come back with it.
    expect(agent!.updatedAt).toBe("2026-08-03T09:02:00.000Z");
    expect(
      applyAgentPanelClearedAt(deriveAgentPanelModel({ agents: [agent!] }), cutoff).hiddenCount,
    ).toBe(0);
  });

  it("stamps session-derived interruption at the session timestamp so a cleared-while-working row returns", () => {
    const rows = [
      activity(
        "task.started",
        { taskId: "working", taskType: "local_agent" },
        "2026-08-01T09:00:00.000Z",
      ),
      activity(
        "task.progress",
        { taskId: "working", status: "running" },
        "2026-08-01T09:01:00.000Z",
      ),
    ];

    const agents = foldSubagentActivities(rows, {
      sessionLive: false,
      sessionUpdatedAt: "2026-08-03T09:05:00.000Z",
    });

    expect(agents[0]!.status).toBe("interrupted");
    expect(agents[0]!.updatedAt).toBe("2026-08-03T09:05:00.000Z");
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:01:00.000Z");
    // Cleared while it was working (active rows survive a clear), then killed
    // by session death after the cutoff: it must stay visible.
    expect(applyAgentPanelClearedAt(deriveAgentPanelModel({ agents }), cutoff).hiddenCount).toBe(0);
  });

  it("falls back to the newest activity for session death and never stamps backwards", () => {
    const rows = [
      activity(
        "task.started",
        { taskId: "working", taskType: "local_agent" },
        "2026-08-01T09:00:00.000Z",
      ),
      activity(
        "task.progress",
        { taskId: "working", status: "running" },
        "2026-08-01T09:01:00.000Z",
      ),
      activity(
        "task.started",
        { taskId: "other", taskType: "local_agent" },
        "2026-08-01T09:03:00.000Z",
      ),
    ];

    expect(foldSubagentActivities(rows, { sessionLive: false })[0]!.updatedAt).toBe(
      "2026-08-01T09:03:00.000Z",
    );
    // A session record older than the row cannot drag the stamp back.
    expect(
      foldSubagentActivities(rows, {
        sessionLive: false,
        sessionUpdatedAt: "2026-07-01T00:00:00.000Z",
      })[0]!.updatedAt,
    ).toBe("2026-08-01T09:01:00.000Z");
  });

  it("keeps a coordinator cascade from stamping a member in the past", () => {
    const agents = fold([
      activity(
        "task.started",
        { taskId: "wf", taskType: "local_workflow" },
        "2026-08-01T10:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "wf", taskType: "local_workflow", status: "failed" },
        "2026-08-01T10:02:00.000Z",
      ),
      activity(
        "task.progress",
        { taskId: "wf:member", parentAgentId: "wf", status: "running" },
        "2026-08-01T10:05:00.000Z",
      ),
    ]);
    const member = agents.find((agent) => agent.id === "wf:member")!;

    expect(member.status).toBe("interrupted");
    expect(member.updatedAt).toBe("2026-08-01T10:05:00.000Z");
  });
});

describe("latestAgentActivityAt", () => {
  const model = (agents: ReadonlyArray<OrchestrationThreadActivity>) =>
    deriveAgentPanelModel({ agents: fold(agents) });

  it("returns the newest updatedAt across workflows and direct agents", () => {
    expect(
      latestAgentActivityAt(
        model([
          activity(
            "task.started",
            { taskId: "wf", taskType: "local_workflow" },
            "2026-08-01T11:00:00.000Z",
          ),
          activity(
            "task.progress",
            { taskId: "wf:member", parentAgentId: "wf", status: "completed" },
            "2026-08-01T11:04:00.000Z",
          ),
          activity(
            "task.completed",
            { taskId: "wf", taskType: "local_workflow", status: "completed" },
            "2026-08-01T11:02:00.000Z",
          ),
          activity(
            "task.started",
            { taskId: "direct", taskType: "local_agent" },
            "2026-08-01T11:01:00.000Z",
          ),
          activity(
            "task.progress",
            { taskId: "direct", status: "running" },
            "2026-08-01T11:03:00.000Z",
          ),
        ]),
      ),
    ).toBe("2026-08-01T11:04:00.000Z");
  });

  it("returns null for an empty panel and skips undateable rows", () => {
    expect(latestAgentActivityAt(emptyAgentPanelModel())).toBe(null);
    const dated = model([
      activity(
        "task.started",
        { taskId: "dated", taskType: "local_agent" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]).directAgents[0]!;
    expect(
      latestAgentActivityAt(
        deriveAgentPanelModel({
          agents: [dated, { ...dated, id: "undateable", updatedAt: "not-a-timestamp" }],
        }),
      ),
    ).toBe("2026-08-01T12:00:00.000Z");
    expect(
      latestAgentActivityAt(
        deriveAgentPanelModel({ agents: [{ ...dated, updatedAt: "not-a-timestamp" }] }),
      ),
    ).toBe(null);
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
