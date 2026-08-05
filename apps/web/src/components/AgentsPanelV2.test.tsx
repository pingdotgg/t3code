import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanelV2 } from "./AgentsPanelV2";
import { makeThreadProjectionFixture } from "../test-fixtures";

const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
const workflowId = NodeId.make("workflow-1");

const agent = (id: string, input: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent =>
  ({
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-test"),
    runId: RunId.make("run-test"),
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
  }) as OrchestrationV2Subagent;

const renderPanel = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
  renderToStaticMarkup(
    <AgentsPanelV2 projection={{ ...makeThreadProjectionFixture(), subagents }} />,
  );

describe("AgentsPanelV2", () => {
  it("renders a workflow coordinator as a card before its members exist", () => {
    // The Claude-only workflow path. A coordinator arrives before any member
    // does, so rendering it as a bare heading left the panel showing a title,
    // no rows, and "0 active" while the workflow was running.
    const markup = renderPanel([
      agent("workflow-1", {
        kind: "workflow",
        title: "Refactor sweep",
        role: { name: "workflow-coordinator", source: "app_default" },
        status: "running",
        usage: { totalTokens: 5000 },
        workflow: { phases: [{ index: 0, title: "Research" }] },
      }),
    ]);

    expect(markup).toContain("Refactor sweep");
    expect(markup).toContain("workflow-coordinator");
    // Its own model and usage only appear if it rendered as a card.
    expect(markup).toContain("claude-opus-4-1");
    expect(markup).toContain("5k tokens");
    expect(markup).toContain("1 active");
    expect(markup).toContain("Research");
  });

  it("shows the final result instead of stale progress for a settled agent", () => {
    const markup = renderPanel([
      agent("settled-agent", {
        status: "idle",
        progress: "Still working on the old step",
        result: "Final answer from the agent",
      }),
    ]);

    expect(markup).toContain("Final answer from the agent");
    expect(markup).not.toContain("Still working on the old step");
  });

  it("renders workflow members under their phase", () => {
    const markup = renderPanel([
      agent("workflow-1", {
        kind: "workflow",
        title: "Refactor sweep",
        status: "running",
        workflow: {
          phases: [
            { index: 0, title: "Research" },
            { index: 1, title: "Implement" },
          ],
        },
      }),
      agent("researcher", {
        kind: "workflow_agent",
        title: "researcher",
        status: "completed",
        workflowMembership: {
          workflowSubagentId: workflowId,
          agentIndex: 0,
          phaseIndex: 0,
          attempt: 1,
        },
      }),
      agent("implementer", {
        kind: "workflow_agent",
        title: "implementer",
        status: "running",
        workflowMembership: {
          workflowSubagentId: workflowId,
          agentIndex: 0,
          phaseIndex: 1,
          attempt: 1,
        },
      }),
    ]);

    expect(markup).toContain("Research");
    expect(markup).toContain("Implement");
    expect(markup).toContain("researcher");
    expect(markup).toContain("implementer");
    // Members represent the coordinator's work, so only they are tallied.
    expect(markup).toContain("1 active");
    expect(markup).toContain("1 settled");
  });

  it("keeps a member visible when its coordinator is missing", () => {
    const markup = renderPanel([
      agent("orphan", {
        kind: "workflow_agent",
        title: "orphaned-worker",
        workflowMembership: {
          workflowSubagentId: workflowId,
          agentIndex: 0,
          phaseIndex: 0,
          attempt: 1,
        },
      }),
    ]);

    expect(markup).toContain("orphaned-worker");
  });
});
