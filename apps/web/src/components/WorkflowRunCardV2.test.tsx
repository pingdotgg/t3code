import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { deriveOrchestrationV2WorkflowRunCard } from "@t3tools/client-runtime/state/orchestration-v2-subagents";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkflowRunCardV2, safeWorkflowSessionUrl } from "./WorkflowRunCardV2";

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

const membership = (agentIndex: number, phaseIndex: number | null) => ({
  workflowSubagentId: workflowId,
  agentIndex,
  phaseIndex,
  attempt: 1,
});

const renderCard = (subagents: ReadonlyArray<OrchestrationV2Subagent>) => {
  const card = deriveOrchestrationV2WorkflowRunCard({ coordinatorId: workflowId, subagents });
  if (card === null) throw new Error("expected a workflow run card");
  return renderToStaticMarkup(<WorkflowRunCardV2 card={card} />);
};

describe("WorkflowRunCardV2", () => {
  const coordinator = agent("workflow-1", {
    kind: "workflow",
    title: "Research and implement",
    status: "running",
    usage: { totalTokens: 1500 },
    workflow: {
      phases: [
        { index: 0, title: "Research" },
        { index: 1, title: "Implement" },
      ],
      name: "research-implement",
    },
  });

  it("renders phases, member rows, and the usage rollup", () => {
    const html = renderCard([
      coordinator,
      agent("member-research", {
        kind: "workflow_agent",
        title: "Researcher",
        status: "completed",
        usage: { totalTokens: 400 },
        workflowMembership: membership(0, 0),
      }),
      agent("member-implement", {
        kind: "workflow_agent",
        title: "Implementer",
        status: "running",
        usage: { totalTokens: 500 },
        workflowMembership: membership(1, 1),
      }),
    ]);

    expect(html).toContain("Research and implement");
    expect(html).toContain("Research");
    expect(html).toContain("Implement");
    expect(html).toContain("Researcher");
    expect(html).toContain("Implementer");
    expect(html).toContain("1/2 agents");
    expect(html).toContain("1.5k tok");
    expect(html).toContain('data-workflow-status="running"');
  });

  it("shows failed member rows with their error text and a failed chip on the coordinator", () => {
    const html = renderCard([
      agent("workflow-1", {
        ...coordinator,
        status: "failed",
      }),
      agent("member-broken", {
        kind: "workflow_agent",
        title: "Broken agent",
        status: "failed",
        result: "TypeError: cannot read x",
        workflowMembership: membership(0, 0),
      }),
    ]);

    expect(html).toContain('data-workflow-status="failed"');
    expect(html).toContain("TypeError: cannot read x");
  });

  it("caps member rows and reports the hidden remainder", () => {
    const members = Array.from({ length: 11 }, (_, index) =>
      agent(`member-${index}`, {
        kind: "workflow_agent",
        title: `Agent ${index}`,
        status: "completed",
        workflowMembership: membership(index, 0),
      }),
    );
    const html = renderCard([
      agent("workflow-1", {
        ...coordinator,
        workflow: { phases: [{ index: 0, title: "Sweep" }], name: "sweep" },
      }),
      ...members,
    ]);

    expect(html).toContain("+3 more agents");
  });

  it("renders a remote run as a session link instead of member rows", () => {
    const html = renderCard([
      agent("workflow-1", {
        ...coordinator,
        workflow: {
          phases: [],
          name: "remote-run",
          sessionUrl: "https://claude.ai/session/abc",
        },
      }),
    ]);

    expect(html).toContain("Running in the cloud");
    expect(html).toContain('href="https://claude.ai/session/abc"');
  });

  it("shows the coordinator warning when present", () => {
    const html = renderCard([
      agent("workflow-1", {
        ...coordinator,
        workflow: {
          phases: [],
          name: "warned",
          warning: "workflow exceeded the size guideline",
        },
      }),
    ]);

    expect(html).toContain("workflow exceeded the size guideline");
  });
});

describe("safeWorkflowSessionUrl", () => {
  it("only lets web URLs through", () => {
    expect(safeWorkflowSessionUrl("https://claude.ai/session/abc")).toBe(
      "https://claude.ai/session/abc",
    );
    expect(safeWorkflowSessionUrl("http://localhost:3000/run")).toBe("http://localhost:3000/run");
    // A hostile payload persisted before the adapter-side filter existed
    // must not reach an anchor href.
    expect(safeWorkflowSessionUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeWorkflowSessionUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeWorkflowSessionUrl("not a url")).toBeUndefined();
    expect(safeWorkflowSessionUrl(undefined)).toBeUndefined();
  });
});
