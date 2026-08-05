import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SubagentActivationId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentActivation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveOrchestrationV2SubagentPanelState,
  deriveOrchestrationV2WorkflowRunCard,
  formatSubagentTokenCount,
  orchestrationV2WorkflowMemberIds,
} from "./orchestrationV2Subagents.ts";

const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
const threadId = ThreadId.make("thread-agents");
const runId = RunId.make("run-agents");
const workflowId = NodeId.make("workflow-1");

const agent = (
  id: string,
  input: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId,
  runId,
  parentNodeId: NodeId.make("root-node"),
  origin: "provider_native",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: "Work",
  title: id,
  model: "claude-opus-4-1",
  kind: "subagent",
  role: { name: "general-purpose", source: "provider" },
  status: "running",
  result: null,
  usage: null,
  currentActivationId: null,
  activationCount: 1,
  workflow: null,
  workflowMembership: null,
  recentActivity: [],
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  ...input,
});

const activation = (
  id: string,
  subagentId: OrchestrationV2Subagent["id"],
  ordinal: number,
): OrchestrationV2SubagentActivation => ({
  id: SubagentActivationId.make(id),
  threadId,
  subagentId,
  runId,
  providerTurnId: null,
  ordinal,
  status: "completed",
  usage: { totalTokens: ordinal * 100 },
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

describe("deriveOrchestrationV2SubagentPanelState", () => {
  it("groups workflow agents by phase without double-counting workflow usage", () => {
    const workflow = agent("workflow-1", {
      kind: "workflow",
      role: { name: "workflow-coordinator", source: "app_default" },
      status: "completed",
      usage: { totalTokens: 900 },
      workflow: {
        phases: [
          { index: 0, title: "Research" },
          { index: 1, title: "Implement" },
        ],
      },
    });
    const researcher = agent("researcher", {
      kind: "workflow_agent",
      usage: { totalTokens: 600 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const auditor = agent("auditor", {
      kind: "workflow_agent",
      status: "completed",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const implementer = agent("implementer", {
      kind: "workflow_agent",
      status: "idle",
      usage: { totalTokens: 500 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: 1,
        attempt: 1,
      },
    });
    const activations = [
      activation("activation-researcher-1", researcher.id, 1),
      activation("activation-researcher-2", researcher.id, 2),
    ];

    const result = deriveOrchestrationV2SubagentPanelState({
      subagents: [workflow, researcher, auditor, implementer],
      activations,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.phases.map((phase) => phase.title)).toEqual(["Research", "Implement"]);
    expect(result.groups[0]?.phases[0]?.agents).toEqual([auditor, researcher]);
    expect(result.activeCount).toBe(1);
    expect(result.settledCount).toBe(2);
    expect(result.totalTokens).toBe(900);
    expect(result.activationsBySubagentId.get(researcher.id)).toEqual(activations);
  });

  it("keeps future all-pending workflow phases pending", () => {
    const workflow = agent("workflow-1", {
      kind: "workflow",
      workflow: {
        phases: [
          { index: 0, title: "Empty" },
          { index: 1, title: "Queued" },
          { index: 2, title: "Active" },
          { index: 3, title: "Settled" },
        ],
      },
    });
    const member = (id: string, phaseIndex: number, status: OrchestrationV2Subagent["status"]) =>
      agent(id, {
        kind: "workflow_agent",
        status,
        workflowMembership: {
          workflowSubagentId: workflowId,
          agentIndex: phaseIndex,
          phaseIndex,
          attempt: 1,
        },
      });

    const result = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        workflow,
        member("queued-a", 1, "pending"),
        member("queued-b", 1, "pending"),
        member("active", 2, "waiting"),
        member("settled", 3, "completed"),
      ],
      activations: [],
    });

    expect(result.groups[0]?.phases.map((phase) => phase.status)).toEqual([
      "pending",
      "pending",
      "running",
      "done",
    ]);
  });

  it("marks empty phases done once the workflow settles", () => {
    // A settled coordinator will never populate a phase it skipped; leaving
    // it "pending" showed a completed workflow still waiting on one.
    const result = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "completed",
          workflow: {
            phases: [
              { index: 0, title: "Work" },
              { index: 1, title: "Report" },
            ],
          },
        }),
        agent("member", {
          kind: "workflow_agent",
          status: "completed",
          workflowMembership: {
            workflowSubagentId: workflowId,
            agentIndex: 0,
            phaseIndex: 0,
            attempt: 1,
          },
        }),
      ],
      activations: [],
    });

    expect(result.groups[0]?.phases.map((phase) => phase.status)).toEqual(["done", "done"]);
  });

  it("distinguishes unavailable usage from a reported zero", () => {
    const unavailable = deriveOrchestrationV2SubagentPanelState({
      subagents: [agent("unreported")],
      activations: [],
    });
    const reportedZero = deriveOrchestrationV2SubagentPanelState({
      subagents: [agent("reported-zero", { usage: { totalTokens: 0 } })],
      activations: [],
    });

    expect(unavailable.totalTokens).toBeNull();
    expect(reportedZero.totalTokens).toBe(0);
  });

  it("keeps workflow usage the members did not account for", () => {
    // A provider can report the workflow's own usage while omitting per-agent
    // tokens. Excluding the coordinator outright then erased the entire
    // workflow from the total and the header read "Usage unavailable".
    const workflow = agent("workflow-1", {
      kind: "workflow",
      status: "completed",
      usage: { totalTokens: 5000 },
      workflow: { phases: [] },
    });
    const silentMember = agent("silent-member", {
      kind: "workflow_agent",
      status: "completed",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: null,
        attempt: 1,
      },
    });
    const partialMember = agent("partial-member", {
      kind: "workflow_agent",
      status: "completed",
      usage: { totalTokens: 200 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: null,
        attempt: 1,
      },
    });

    expect(
      deriveOrchestrationV2SubagentPanelState({
        subagents: [workflow, silentMember],
        activations: [],
      }).totalTokens,
    ).toBe(5000);
    expect(
      deriveOrchestrationV2SubagentPanelState({
        subagents: [workflow, silentMember, partialMember],
        activations: [],
      }).totalTokens,
    ).toBe(5000);
  });

  it("counts a workflow that has no members yet", () => {
    // Before its members are spawned the coordinator is the only row on the
    // thread. Excluding it reported "0 active" while a workflow was visibly
    // running, with nothing listed to explain the tokens in the header.
    const running = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "running",
          usage: { totalTokens: 5000 },
          workflow: { phases: [{ index: 0, title: "Research" }] },
        }),
      ],
      activations: [],
    });

    expect(running.activeCount).toBe(1);
    expect(running.settledCount).toBe(0);
    expect(running.totalTokens).toBe(5000);
    expect(running.groups[0]?.workflow?.id).toBe(workflowId);
  });

  it("keeps a running coordinator counted while its members are all settled", () => {
    // Between phases every member of the finished phase is settled while the
    // next phase's members do not exist yet; the coordinator is the only live
    // row and dropping it read "0 active" for a workflow visibly running.
    const betweenPhases = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "running",
          workflow: { phases: [{ index: 0, title: "Research" }] },
        }),
        agent("member-done", {
          kind: "workflow_agent",
          status: "completed",
          workflowMembership: {
            workflowSubagentId: workflowId,
            agentIndex: 0,
            phaseIndex: 0,
            attempt: 1,
          },
        }),
      ],
      activations: [],
    });
    expect(betweenPhases.activeCount).toBe(1);

    // An active member takes over the representation again.
    const memberActive = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "running",
          workflow: { phases: [{ index: 0, title: "Research" }] },
        }),
        agent("member-running", {
          kind: "workflow_agent",
          status: "running",
          workflowMembership: {
            workflowSubagentId: workflowId,
            agentIndex: 0,
            phaseIndex: 0,
            attempt: 1,
          },
        }),
      ],
      activations: [],
    });
    expect(memberActive.activeCount).toBe(1);

    // A settled coordinator stays represented by its settled members.
    const finished = deriveOrchestrationV2SubagentPanelState({
      subagents: [
        agent("workflow-1", {
          kind: "workflow",
          status: "completed",
          workflow: { phases: [{ index: 0, title: "Research" }] },
        }),
        agent("member-done", {
          kind: "workflow_agent",
          status: "completed",
          workflowMembership: {
            workflowSubagentId: workflowId,
            agentIndex: 0,
            phaseIndex: 0,
            attempt: 1,
          },
        }),
      ],
      activations: [],
    });
    expect(finished.activeCount).toBe(0);
    expect(finished.settledCount).toBe(1);
  });

  it("orders and groups without ES2023 change-by-copy array methods", () => {
    // client-runtime is mobile-reachable and Hermes lacks toSorted/toReversed;
    // deleting them proves this module never reaches for one.
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Reflect.deleteProperty(Array.prototype, "toSorted");
    try {
      const workflow = agent("workflow-1", {
        kind: "workflow",
        workflow: { phases: [{ index: 0, title: "Work" }] },
      });
      const member = (id: string, agentIndex: number) =>
        agent(id, {
          kind: "workflow_agent",
          workflowMembership: {
            workflowSubagentId: workflowId,
            agentIndex,
            phaseIndex: 0,
            attempt: 1,
          },
        });
      const subagents = [workflow, member("second", 1), member("first", 0)];

      const panel = deriveOrchestrationV2SubagentPanelState({ subagents, activations: [] });
      expect(panel.groups[0]?.phases[0]?.agents.map((a) => String(a.id))).toEqual([
        "first",
        "second",
      ]);
      const card = deriveOrchestrationV2WorkflowRunCard({ coordinatorId: workflowId, subagents });
      expect(card?.phases[0]?.agents.map((a) => String(a.id))).toEqual(["first", "second"]);
    } finally {
      if (descriptor) Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  });

  it("formats compact token counts", () => {
    expect(formatSubagentTokenCount(999)).toBe("999");
    expect(formatSubagentTokenCount(1_200)).toBe("1.2k");
    expect(formatSubagentTokenCount(999_999)).toBe("1M");
    expect(formatSubagentTokenCount(2_000_000)).toBe("2M");
  });
});

describe("deriveOrchestrationV2WorkflowRunCard", () => {
  const workflow = agent("workflow-1", {
    kind: "workflow",
    role: { name: "workflow-coordinator", source: "app_default" },
    usage: { totalTokens: 1500 },
    workflow: {
      phases: [
        { index: 0, title: "Research" },
        { index: 1, title: "Implement" },
      ],
      name: "research-implement",
      runId: "wf_run_1",
    },
  });
  const researcher = agent("member-research", {
    kind: "workflow_agent",
    status: "completed",
    usage: { totalTokens: 400 },
    workflowMembership: {
      workflowSubagentId: workflowId,
      agentIndex: 0,
      phaseIndex: 0,
      attempt: 1,
    },
  });
  const implementer = agent("member-implement", {
    kind: "workflow_agent",
    status: "running",
    usage: { totalTokens: 500 },
    workflowMembership: {
      workflowSubagentId: workflowId,
      agentIndex: 1,
      phaseIndex: 1,
      attempt: 1,
    },
  });

  it("derives phases, counts, and the coordinator's usage for a coordinator id", () => {
    const card = deriveOrchestrationV2WorkflowRunCard({
      coordinatorId: workflowId,
      subagents: [workflow, researcher, implementer, agent("unrelated")],
    });

    expect(card?.coordinator.id).toBe(workflowId);
    expect(card?.phases.map((phase) => [phase.title, phase.status])).toEqual([
      ["Research", "done"],
      ["Implement", "running"],
    ]);
    expect(card?.memberCount).toBe(2);
    expect(card?.settledMemberCount).toBe(1);
    expect(card?.failedMemberCount).toBe(0);
    expect(card?.totalTokens).toBe(1500);
    expect(card?.unphasedAgents).toEqual([]);
  });

  it("returns null for anything that is not a workflow coordinator", () => {
    const subagents = [workflow, researcher];
    expect(
      deriveOrchestrationV2WorkflowRunCard({
        coordinatorId: researcher.id,
        subagents,
      }),
    ).toBeNull();
    expect(
      deriveOrchestrationV2WorkflowRunCard({
        coordinatorId: NodeId.make("missing"),
        subagents,
      }),
    ).toBeNull();
  });

  it("keeps members without a declared phase visible and sums their usage as fallback", () => {
    const silentCoordinator = agent("workflow-1", {
      kind: "workflow",
      workflow: { phases: [{ index: 0, title: "Research" }] },
    });
    const phaseless = agent("member-phaseless", {
      kind: "workflow_agent",
      usage: { totalTokens: 250 },
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 2,
        phaseIndex: null,
        attempt: 1,
      },
    });
    const card = deriveOrchestrationV2WorkflowRunCard({
      coordinatorId: workflowId,
      subagents: [silentCoordinator, phaseless],
    });

    expect(card?.unphasedAgents.map((member) => member.id)).toEqual([phaseless.id]);
    // No coordinator total reported — the member sum is better than
    // "usage unavailable" for a workflow that visibly spent tokens.
    expect(card?.totalTokens).toBe(250);
  });
});

describe("orchestrationV2WorkflowMemberIds", () => {
  it("hides only members whose coordinator reached the projection", () => {
    const workflow = agent("workflow-1", { kind: "workflow" });
    const member = agent("member-1", {
      kind: "workflow_agent",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const orphan = agent("member-orphan", {
      kind: "workflow_agent",
      workflowMembership: {
        workflowSubagentId: NodeId.make("missing-workflow"),
        agentIndex: 0,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const direct = agent("direct-1");

    const hidden = orchestrationV2WorkflowMemberIds([workflow, member, orphan, direct]);
    expect([...hidden]).toEqual([member.id]);
  });
});
