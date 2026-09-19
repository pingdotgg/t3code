import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2Subagent, OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveAgentPanelModel, projectedSubagentsToRuntime } from "./subagentRuntime.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const panelOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveAgentPanelModel({ agents: [], v2Projection: projectedSubagentsToRuntime(subagents) });

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it("leaves a plain subagent flat", () => {
    const [agent, ...rest] = projectedSubagentsToRuntime([subagent()]);
    expect(rest).toEqual([]);
    expect(agent?.kind).toBe("subagent");
    expect(agent?.phases).toEqual([]);
  });

  it("projects a coordinator plus one row per member", () => {
    const rows = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [member(), member({ index: 2, label: "alpha:two", state: "queued" })],
          totalTokens: 1000,
        },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["workflow", "workflow_agent", "workflow_agent"]);
    expect(rows[0]?.workflowName).toBe("probe-wf");
    expect(rows[0]?.usage?.totalTokens).toBe(1000);
    expect(rows[1]).toMatchObject({
      id: "coordinator:agent:1",
      title: "alpha:one",
      parentAgentId: "coordinator",
      phaseIndex: 1,
      phaseTitle: "Alpha",
      status: "running",
    });
    // A queued member is not started work: it must not report an elapsed clock.
    expect(rows[2]?.status).toBe("pending");
    expect(rows[2]?.startedAt).toBeNull();
  });

  it("derives a settled member's end from its reported duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:01.500Z");
    expect(settled?.result).toBe("A1");
    // The prompt stays on progress so the detail view can show both halves.
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it("surfaces a retried member through the row's activation count", () => {
    const [, retried] = projectedSubagentsToRuntime([
      subagent({ workflow: { phases: [], agents: [member({ attempt: 3 })] } }),
    ]);
    expect(retried?.activationCount).toBe(3);
    expect(retried?.attempt).toBe(3);
  });
});

describe("deriveAgentPanelModel over a dynamic workflow", () => {
  it("groups members under their phases and counts the run", () => {
    const model = panelOf([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
        },
      }),
    ]);
    const group = model.workflows[0];
    expect(group?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Alpha", "done"],
      ["Beta", "running"],
    ]);
    expect(group?.phases.map((phase) => [phase.activeCount, phase.settledCount])).toEqual([
      [0, 2],
      [2, 0],
    ]);
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it("shows a phase the script only reached at runtime", () => {
    const model = panelOf([
      subagent({
        workflow: {
          // The declared plan has not caught up with the member's phase yet.
          phases: [{ index: 1, title: "Alpha" }],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "dynamic:late", phaseIndex: 3, phaseTitle: "Gamma" }),
          ],
        },
      }),
    ]);
    const group = model.workflows[0];
    expect(group?.phases.map((phase) => phase.title)).toEqual(["Alpha", "Gamma"]);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it("keeps a settled run's members reachable under the coordinator", () => {
    const model = panelOf([
      subagent({
        status: "completed",
        completedAt: at("2026-08-01T10:00:09.000Z"),
        workflow: { phases: [], agents: [member({ state: "completed" })] },
      }),
    ]);
    const group = model.workflows[0];
    expect(group?.workflow.status).toBe("completed");
    expect(group?.phases.flatMap((phase) => phase.members).map((agent) => agent.title)).toEqual([
      "alpha:one",
    ]);
  });

  it("does not count a coordinator's aggregate tokens on top of its members", () => {
    const model = panelOf([
      subagent({
        workflow: {
          phases: [],
          agents: [member({ state: "completed", totalTokens: 400 })],
          totalTokens: 400,
        },
      }),
    ]);
    expect(model.totalTokens).toBe(400);
  });
});
