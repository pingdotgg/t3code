import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { I18nProvider } from "../i18n";
import {
  AgentsPanel,
  createAgentPanelViewState,
  findAgentPanelEntry,
  listAgentPanelEntries,
} from "./AgentsPanel";

function activity(
  id: string,
  taskId: string,
  transcriptEntry: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: `2026-08-24T00:00:${id.slice(-2).padStart(2, "0")}.000Z`,
    tone: "info",
    kind: "task.progress",
    summary: "Agent activity",
    payload: {
      taskId,
      title: taskId === "child-1" ? "Inspect folding" : "Review persistence",
      agentKind: "agent",
      status: "running",
      transcriptEntry,
    },
    turnId: null,
  };
}

function buildModel(reasoningStatus = "inProgress") {
  return deriveAgentPanelModel({
    agents: foldSubagentActivities([
      activity("activity-01", "child-1", {
        id: "assistant-1",
        kind: "assistant",
        phase: "commentary",
        text: "I found the folding boundary.",
      }),
      activity("activity-02", "child-1", {
        id: "reasoning-1",
        kind: "reasoning",
        text: "The summary is the stable boundary.",
        status: reasoningStatus,
      }),
      activity("activity-03", "child-1", {
        id: "tool-1",
        kind: "tool",
        itemType: "command_execution",
        label: "Read timeline logic",
        status: "completed",
        text: "rg output",
      }),
      activity("activity-04", "child-2", {
        id: "assistant-2",
        kind: "assistant",
        phase: "commentary",
        text: "This belongs to the other agent.",
      }),
    ]),
  });
}

function buildWorkflowModel() {
  const workflowActivity = (
    id: string,
    kind: OrchestrationThreadActivity["kind"],
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity => ({
    id: EventId.make(id),
    createdAt: `2026-08-24T00:01:${id.slice(-2).padStart(2, "0")}.000Z`,
    tone: "info",
    kind,
    summary: "Workflow activity",
    payload: { ...payload, agentKind: "agent" },
    turnId: null,
  });

  return deriveAgentPanelModel({
    agents: foldSubagentActivities([
      workflowActivity("workflow-01", "task.started", {
        taskId: "workflow-1",
        taskType: "local_workflow",
        title: "Review agent tabs",
      }),
      workflowActivity("workflow-02", "task.progress", {
        taskId: "workflow-1",
        phases: [
          { index: 0, title: "Inspect" },
          { index: 1, title: "Verify" },
        ],
      }),
      workflowActivity("workflow-03", "task.progress", {
        taskId: "workflow-1:wf:1",
        title: "Verify tabs",
        status: "running",
        parentAgentId: "workflow-1",
        agentIndex: 1,
        phaseIndex: 1,
      }),
      workflowActivity("workflow-04", "task.progress", {
        taskId: "workflow-1:wf:0",
        title: "Inspect tabs",
        status: "completed",
        parentAgentId: "workflow-1",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]),
  });
}

describe("AgentsPanel", () => {
  it("renders a stable localized tombstone when a persisted agent is unavailable", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <AgentsPanel model={emptyAgentPanelModel()} agentId="missing" />
      </I18nProvider>,
    );

    expect(markup).toContain("此 Agent 已不可用。");
  });

  it("lists each subagent once in stable model order", () => {
    expect(listAgentPanelEntries(buildModel()).map(({ agent }) => agent.id)).toEqual([
      "child-1",
      "child-2",
    ]);
  });

  it("creates tabs for workflow members in phase order without exposing the coordinator", () => {
    const model = buildWorkflowModel();
    expect(listAgentPanelEntries(model).map(({ agent }) => agent.id)).toEqual([
      "workflow-1:wf:0",
      "workflow-1:wf:1",
    ]);
    expect(findAgentPanelEntry(model, "workflow-1")?.agent.kind).toBe("workflow");
  });

  it("renders only the selected agent as a read-only main-conversation-style transcript", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <AgentsPanel model={buildModel()} agentId="child-1" />
      </I18nProvider>,
    );

    expect(markup).toContain("Inspect folding");
    expect(markup).toContain("I found the folding boundary.");
    expect(markup).toContain("The summary is the stable boundary.");
    expect(markup).toContain("Read timeline logic");
    expect(markup).toContain('data-agent-transcript-kind="assistant"');
    expect(markup).toContain('data-agent-transcript-kind="reasoning"');
    expect(markup).toContain('data-agent-transcript-kind="tool"');
    expect(markup).toContain("assistant-reasoning-block");
    expect(markup).toContain("text-secondary-label");
    expect(markup).not.toContain("Review persistence");
    expect(markup).not.toContain("This belongs to the other agent.");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain('role="textbox"');
    expect(markup).not.toContain("contenteditable");
  });

  it("restores disclosure state independently for a remounted agent tab", () => {
    const viewState = createAgentPanelViewState();
    viewState.expandedToolEntryIds.add("tool-1");
    viewState.reasoningOpenByEntryId.set("reasoning-1", false);

    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AgentsPanel model={buildModel()} agentId="child-1" viewState={viewState} />
      </I18nProvider>,
    );

    expect(markup).toContain("rg output");
    expect(markup).toContain('data-reasoning-open="false"');

    viewState.reasoningOpenByEntryId.set("reasoning-1", true);
    viewState.reasoningStreamingByEntryId.set("reasoning-1", true);
    const completedMarkup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AgentsPanel model={buildModel("completed")} agentId="child-1" viewState={viewState} />
      </I18nProvider>,
    );
    expect(completedMarkup).toContain('data-reasoning-open="false"');
  });
});
