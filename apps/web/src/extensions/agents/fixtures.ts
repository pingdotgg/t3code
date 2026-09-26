import {
  deriveAgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AgentsBindings } from "./index";

export function agentFixture(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "direct",
    kind: "subagent",
    title: "Direct reviewer",
    role: "reviewer",
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-09T10:00:00.000Z",
    startedAt: "2026-09-09T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  };
}

export function agentsFixture(): AgentsBindings {
  return {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
    model: deriveAgentPanelModel({
      agents: [
        agentFixture({
          id: "workflow",
          kind: "workflow",
          title: "Review workflow",
          phases: [
            { index: 0, title: "Investigate" },
            { index: 1, title: "Verify" },
          ],
          runHandles: { scriptPath: ".t3/workflows/review.ts" },
        }),
        agentFixture({
          id: "child",
          kind: "workflow_agent",
          title: "Workflow investigator",
          parentAgentId: "workflow",
          phaseIndex: 0,
          progress: "Reading source",
        }),
        agentFixture({
          id: "pending-child",
          kind: "workflow_agent",
          title: "Workflow verifier",
          parentAgentId: "workflow",
          phaseIndex: 1,
          status: "pending",
        }),
        ...(
          [
            "pending",
            "running",
            "waiting",
            "idle",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ] as const
        ).map((status) =>
          agentFixture({
            id: status,
            title: `Direct ${status}`,
            status,
            error: status === "failed" ? "Fixture failure" : null,
            result: status === "completed" ? "Review finished" : null,
          }),
        ),
      ],
    }),
  };
}
