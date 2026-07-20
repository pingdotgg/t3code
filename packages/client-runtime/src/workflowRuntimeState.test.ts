import { describe, expect, it } from "vitest";
import type { OrchestrationEvent, WorkflowArtifact, WorkflowRun } from "@t3tools/contracts";
import { ThreadId, WorkflowArtifactId, WorkflowNodeId, WorkflowRunId } from "@t3tools/contracts";
import {
  applyWorkflowRuntimeEvent,
  createWorkflowRuntimeState,
  selectWorkflowRunsForParentThread,
} from "./workflowRuntimeState.ts";

const parentThreadId = ThreadId.make("thread-parent");
const workerThreadId = ThreadId.make("thread-worker");
const runId = WorkflowRunId.make("run-1");
const nodeId = WorkflowNodeId.make("node-1");

const run: WorkflowRun = {
  id: runId,
  workflowId: "workflow-1",
  parentThreadId,
  status: "pending",
  nodes: [{ nodeId, status: "pending" }],
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

const inputArtifact: WorkflowArtifact = {
  id: WorkflowArtifactId.make("artifact-input"),
  runId,
  payload: {
    kind: "input-context",
    contextPolicy: "summary",
    parentThreadId,
    messages: [],
    truncated: false,
  },
  createdAt: "2026-07-17T00:00:00.000Z",
};

const resultArtifact: WorkflowArtifact = {
  id: WorkflowArtifactId.make("artifact-result"),
  runId,
  nodeId,
  producerThreadId: workerThreadId,
  payload: {
    kind: "worker-result",
    status: "completed",
    summary: "Repository inspected",
    body: "No blockers found.",
    evidence: [],
    changedPaths: [],
  },
  createdAt: "2026-07-17T00:01:00.000Z",
};

function workflowEvent(
  type:
    | "workflow.run-requested"
    | "workflow.artifact-created"
    | "workflow.node-worker-started"
    | "workflow.worker-result-recorded"
    | "workflow.run-finalized",
  payload: unknown,
): OrchestrationEvent {
  return {
    type,
    occurredAt: "2026-07-17T00:02:00.000Z",
    payload,
  } as OrchestrationEvent;
}

describe("workflow runtime state", () => {
  it("returns a stable presentation snapshot for an unchanged runtime state", () => {
    const state = createWorkflowRuntimeState([
      {
        run,
        definition: {
          id: "workflow-1",
          name: "Repository review",
          nodes: [],
        },
      },
    ]);

    expect(selectWorkflowRunsForParentThread(state, parentThreadId)).toBe(
      selectWorkflowRunsForParentThread(state, parentThreadId),
    );
  });

  it("projects a run, worker navigation, and final artifact from workflow events", () => {
    let state = createWorkflowRuntimeState();
    state = applyWorkflowRuntimeEvent(
      state,
      workflowEvent("workflow.run-requested", {
        run,
        definition: {
          id: "workflow-1",
          name: "Repository review",
          nodes: [
            {
              id: nodeId,
              title: "Inspect repository",
              prompt: "Inspect",
              contextPolicy: "summary",
            },
          ],
        },
      }),
    );
    state = applyWorkflowRuntimeEvent(
      state,
      workflowEvent("workflow.artifact-created", { artifact: inputArtifact }),
    );
    state = applyWorkflowRuntimeEvent(
      state,
      workflowEvent("workflow.node-worker-started", {
        runId,
        nodeId,
        workerThreadId,
        startedAt: "2026-07-17T00:00:30.000Z",
      }),
    );
    expect(state.runsById[runId]).toMatchObject({
      status: "running",
      nodes: [{ status: "running", workerThreadId }],
    });
    state = applyWorkflowRuntimeEvent(
      state,
      workflowEvent("workflow.worker-result-recorded", {
        runId,
        artifact: resultArtifact,
        completedAt: "2026-07-17T00:01:00.000Z",
      }),
    );
    state = applyWorkflowRuntimeEvent(
      state,
      workflowEvent("workflow.run-finalized", {
        runId,
        parentThreadId,
        artifact: {
          ...resultArtifact,
          id: WorkflowArtifactId.make("artifact-final"),
          payload: {
            kind: "final-result",
            summary: "Review complete",
            body: "No blockers found.",
            evidence: [],
          },
        },
        status: "completed",
        completedAt: "2026-07-17T00:02:00.000Z",
      }),
    );

    const [presentation] = selectWorkflowRunsForParentThread(state, parentThreadId);

    expect(presentation?.run).toMatchObject({
      status: "completed",
      finalArtifactId: "artifact-final",
      nodes: [
        {
          status: "completed",
          workerThreadId,
          resultArtifactId: "artifact-result",
        },
      ],
    });
    expect(presentation?.definition?.name).toBe("Repository review");
    expect(presentation?.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-input",
      "artifact-result",
      "artifact-final",
    ]);
  });

  it("marks pending nodes failed when a run is finalized before worker startup", () => {
    const state = applyWorkflowRuntimeEvent(
      createWorkflowRuntimeState([
        {
          run,
          definition: {
            id: "workflow-1",
            name: "Repository review",
            nodes: [],
          },
        },
      ]),
      workflowEvent("workflow.run-finalized", {
        runId,
        parentThreadId,
        artifact: {
          ...resultArtifact,
          id: WorkflowArtifactId.make("artifact-final-failed"),
          payload: {
            kind: "final-result",
            summary: "Worker failed",
            body: "Parent thread was deleted.",
            evidence: [],
          },
        },
        status: "failed",
        completedAt: "2026-07-17T00:02:00.000Z",
      }),
    );

    expect(state.runsById[runId]).toMatchObject({
      status: "failed",
      nodes: [{ status: "failed", completedAt: "2026-07-17T00:02:00.000Z" }],
    });
  });
});
