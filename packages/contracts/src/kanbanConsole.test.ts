import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { KanbanConsoleSnapshot, KanbanConsoleTaskTransitionRequest } from "./kanbanConsole.ts";

const decodeSnapshot = Schema.decodeUnknownSync(KanbanConsoleSnapshot);
const decodeTransitionRequest = Schema.decodeUnknownSync(KanbanConsoleTaskTransitionRequest);

describe("kanbanConsole contracts", () => {
  it("decodes a complete mock-runtime snapshot boundary", () => {
    expect(
      decodeSnapshot({
        version: 1,
        generatedAt: "2026-05-06T13:30:00.000Z",
        locale: "en",
        repos: [
          {
            id: "repo-1",
            name: "kanban-console",
            owner: "MohAnghabo",
            path: "/tmp/kanban-console",
            branch: "feature/contracts",
            ahead: 1,
            behind: 0,
            openPrs: 1,
            activeTasks: 2,
            status: "healthy",
          },
        ],
        boards: [
          {
            id: "board-1",
            owner: "MohAnghabo",
            title: "Kanban Project Console",
            source: "github-projects",
            columns: ["backlog", "ready", "in-progress", "review", "blocked", "done"],
          },
        ],
        tasks: [
          {
            id: "task-1",
            issue: "kanban-console#1",
            title: "Contracts",
            titleAr: "العقود",
            repo: "kanban-console",
            column: "ready",
            priority: "P1",
            assignee: "Codex",
            checks: { passing: 1, pending: 0, failing: 0 },
            agent: "Codex",
            updated: "Today",
            comments: 0,
          },
        ],
        prWatches: [],
        suggestedFixes: [],
        commandRuns: [],
        gitStatuses: [],
        artifacts: [],
        gitOpsPolicy: {
          protectedBranches: ["main"],
          allowedWorkBranchPrefixes: ["feature/"],
          destructiveActionsRequireSecondConfirmation: true,
        },
        releaseReadiness: {
          branch: "release/test",
          gates: [{ id: "gate-1", label: "Validate", status: "pending" }],
        },
        agentWorkflows: [],
      }),
    ).toMatchObject({
      version: 1,
      tasks: [{ id: "task-1", column: "ready" }],
    });
  });

  it("rejects unknown Kanban transition columns", () => {
    expect(() =>
      decodeTransitionRequest({
        taskId: "task-1",
        fromColumn: "ready",
        toColumn: "qa",
        confirmed: false,
      }),
    ).toThrow();
  });
});
