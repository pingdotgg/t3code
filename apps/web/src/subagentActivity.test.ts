import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "./session-logic";
import {
  deriveSubagentActivity,
  deriveSubagentChildEntries,
  subagentEntryKey,
} from "./subagentActivity";

const baseEntry: WorkLogEntry = {
  id: "activity-1",
  createdAt: "2026-07-29T08:00:00.000Z",
  label: "Subagent task",
  tone: "tool",
  itemType: "collab_agent_tool_call",
  toolLifecycleStatus: "inProgress",
};

describe("subagentActivity", () => {
  it("derives Codex agent state and prompt from a collab tool item", () => {
    const activity = deriveSubagentActivity({
      ...baseEntry,
      toolCallId: "call-1",
      toolData: {
        threadId: "parent-thread",
        item: {
          id: "call-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          prompt: "Inspect the event pipeline",
          model: "gpt-5.3-codex",
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": { status: "running", message: "Reading the adapter" },
          },
        },
      },
    });

    expect(activity).toMatchObject({
      key: "call-1",
      title: "Inspect the event pipeline",
      operation: "spawnAgent",
      prompt: "Inspect the event pipeline",
      model: "gpt-5.3-codex",
      status: "running",
      providerThreadIds: ["child-thread"],
      agents: [
        {
          id: "child-thread",
          status: "running",
          message: "Reading the adapter",
        },
      ],
    });
  });

  it("derives OpenCode task metadata and result", () => {
    const activity = deriveSubagentActivity({
      ...baseEntry,
      toolLifecycleStatus: "completed",
      toolData: {
        toolCallId: "call-opencode",
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Inspect the context tab",
            prompt: "Find the existing implementation",
            subagent_type: "explore",
          },
          output: "The panel is implemented in ContextPanel.tsx.",
          metadata: { sessionId: "session-child-1" },
          time: { start: 1_775_000_000_000, end: 1_775_000_005_000 },
        },
      },
    });

    expect(activity).toMatchObject({
      title: "Inspect the context tab",
      operation: "task",
      role: "explore",
      prompt: "Find the existing implementation",
      status: "completed",
      result: "The panel is implemented in ContextPanel.tsx.",
      providerThreadIds: ["session-child-1"],
      agents: [
        {
          id: "session-child-1",
          label: "explore",
          status: "completed",
        },
      ],
    });
  });

  it("matches nested Codex work by receiver thread id", () => {
    const activity = deriveSubagentActivity({
      ...baseEntry,
      toolData: {
        item: {
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
    expect(activity).not.toBeNull();

    const childEntry: WorkLogEntry = {
      id: "child-tool",
      createdAt: baseEntry.createdAt,
      label: "Read file",
      tone: "tool",
      itemType: "dynamic_tool_call",
      toolData: { threadId: "child-thread" },
    };
    const parentEntry = { ...childEntry, id: "parent-tool", toolData: { threadId: "parent" } };

    expect(deriveSubagentChildEntries(activity!, [childEntry, parentEntry])).toEqual([childEntry]);
    expect(subagentEntryKey(baseEntry)).toBe("activity-1");
  });
});
