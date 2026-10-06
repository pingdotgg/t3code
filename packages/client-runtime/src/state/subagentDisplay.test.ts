import { ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { projectedSubagentsToRuntime } from "./subagentRuntime.js";
import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  subagentGroupSummary,
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "./subagentDisplay.js";

describe("projectedSubagentsToRuntime", () => {
  it("expands scoped workflow rows with result navigation and terminal fallback, leaving ordinary agents alone", () => {
    const startedAt = DateTime.makeUnsafe("2026-06-05T10:00:00Z");
    const completedAt = DateTime.add(startedAt, { seconds: 10 });
    const ordinary = {
      id: "ordinary",
      title: "Auditor",
      prompt: "Audit",
      model: null,
      status: "completed" as const,
      result: "Finished",
      startedAt,
      completedAt,
      updatedAt: completedAt,
    };
    const workflow = {
      phases: [{ index: 1, title: "Review" }],
      name: "Audit",
      totalTokens: 300,
      agents: [
        {
          index: 0,
          label: "Reader",
          state: "completed" as const,
          startedAt: DateTime.toEpochMillis(startedAt),
          durationMs: 1000,
          totalTokens: 250,
          lastToolName: "Bash",
          result: "Read",
          childThreadId: ThreadId.make("reader"),
        },
        { index: 1, label: "Writer", state: "running" as const, phaseIndex: 1 },
        {
          index: 2,
          label: "Cached",
          state: "completed" as const,
          startedAt: DateTime.toEpochMillis(startedAt),
        },
      ],
    };
    const rows = projectedSubagentsToRuntime([
      ordinary,
      { ...ordinary, id: "workflow-a", status: "cancelled", workflow },
      { ...ordinary, id: "workflow-b", workflow },
    ]);
    expect(rows[0]).toMatchObject({
      id: "ordinary",
      kind: "subagent",
      status: "completed",
      result: "Finished",
    });
    expect(rows[1]).toMatchObject({
      kind: "workflow",
      workflowName: "Audit",
      usage: { totalTokens: 300 },
    });
    expect(rows[2]).toMatchObject({
      id: "workflow-a:agent:0",
      kind: "workflow_agent",
      lastToolName: "Bash",
      parentAgentId: "workflow-a",
      status: "completed",
      childThreadId: "reader",
      result: "Read",
      completedAt: "2026-06-05T10:00:01.000Z",
    });
    expect(rows[3]).toMatchObject({
      status: "cancelled",
      phaseIndex: 1,
      completedAt: DateTime.formatIso(completedAt),
    });
    expect(rows[4]).toMatchObject({ status: "completed", completedAt: null });
    expect(rows[6]?.id).toBe("workflow-b:agent:0");
  });
});

describe("subagentGroupSummary", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "keeps a mixed group live while a member is %s",
    (status) => {
      expect(subagentGroupSummary([{ status: "completed" }, { status }])).toEqual({
        label: "Kicked off 2 subagents",
        active: true,
        failed: false,
      });
    },
  );

  it("settles the label without disguising a failed member as success", () => {
    const statuses: OrchestrationV2TurnItemStatus[] = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    expect(subagentGroupSummary(statuses.map((status) => ({ status })))).toEqual({
      label: "Ran 4 subagents",
      active: false,
      failed: true,
    });
  });

  it("uses a singular label for one idle member", () => {
    expect(subagentGroupSummary([{ status: "idle" }])).toEqual({
      label: "Ran 1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe("resolveSubagentMetadata", () => {
  it("resolves provider aliases to catalog names, including custom models", () => {
    expect(
      resolveSubagentMetadata({
        model: "claude-haiku-4-5-20251001",
        provider: {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              slug: "claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              shortName: "Haiku 4.5",
              aliases: ["claude-haiku-4-5-20251001"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("Haiku 4.5");
    expect(
      resolveSubagentMetadata({
        model: "my-model",
        provider: {
          driver: ProviderDriverKind.make("acpRegistry"),
          models: [
            {
              slug: "my-model",
              name: "Cloud+ / My custom model",
              subProvider: "Cloud+",
              isCustom: true,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("My custom model");
  });

  it("keeps unknown model identities and does not invent an unreported model", () => {
    expect(resolveSubagentMetadata({ model: " custom/model " }).modelLabel).toBe("custom/model");
    expect(
      resolveSubagentMetadata({
        model: null,
        provider: { driver: ProviderDriverKind.make("codex"), models: [] },
      }).modelLabel,
    ).toBe("Not reported");
    expect(resolveSubagentMetadata({ model: " " }).modelLabel).toBe("Not reported");
  });

  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("shows another project and its branch when the child has a different workspace", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "fix/agents", worktreePath: "/worktrees/agents" },
        childProject: {
          id: ProjectId.make("child"),
          title: "Other project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([
      { label: "Project", value: "Other project" },
      { label: "Branch", value: "fix/agents" },
    ]);
  });

  it("labels a detached worktree or another project workspace without a branch", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: null, worktreePath: "/worktrees/agents" },
      }).workspace,
    ).toEqual([{ label: "Worktree", value: "agents" }]);
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childProject: {
          id: parentThread.projectId,
          title: "Same project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([{ label: "Workspace", value: "other" }]);
  });

  it("hides redundant workspace metadata and tolerates unavailable child shells", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "main", worktreePath: "/repo" },
        childProject: { id: parentThread.projectId, title: "Same project", workspaceRoot: "/repo" },
      }).workspace,
    ).toEqual([]);
    expect(resolveSubagentMetadata({ model: null, parentThread, parentProject }).workspace).toEqual(
      [],
    );
  });
});

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});
