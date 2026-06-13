import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "./types";
import {
  buildAgentRuns,
  buildTerminalProcessRuns,
  isAgentRunActive,
  isThreadAgentRunActive,
  resolveAgentRunStatus,
} from "./runs";

const thread = (overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary =>
  ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    title: "Build runs center",
    interactionMode: "default",
    session: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-06-01T00:00:00.000Z",
      startedAt: "2026-06-01T00:00:01.000Z",
      completedAt: "2026-06-01T00:00:02.000Z",
      assistantMessageId: null,
    },
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as SidebarThreadSummary;

const project = {
  id: ProjectId.make("project-1"),
  environmentId: EnvironmentId.make("env-1"),
  name: "more Code",
  cwd: "/code/t3",
  defaultModelSelection: null,
  scripts: [],
} satisfies Project;

describe("runs", () => {
  it("gives attention states priority over a running turn", () => {
    expect(
      resolveAgentRunStatus(thread({ hasPendingApprovals: true, hasPendingUserInput: true })),
    ).toBe("awaiting-approval");
    expect(resolveAgentRunStatus(thread({ hasPendingUserInput: true }))).toBe("awaiting-input");
    expect(isThreadAgentRunActive(thread({ hasPendingUserInput: true }))).toBe(true);
  });

  it("omits threads that have never run and sorts active runs first", () => {
    const runs = buildAgentRuns({
      projects: [project],
      threads: [
        thread({ id: ThreadId.make("never-ran"), latestTurn: null }),
        thread({ id: ThreadId.make("completed") }),
        thread({
          id: ThreadId.make("running"),
          latestTurn: {
            ...thread().latestTurn!,
            state: "running",
            completedAt: null,
          },
        }),
      ],
    });

    expect(runs.map((run) => run.thread.id)).toEqual(["running", "completed"]);
    expect(runs[0]?.project).toBe(project);
    expect(isAgentRunActive(runs[0]!)).toBe(true);
    expect(isAgentRunActive(runs[1]!)).toBe(false);
  });

  it("builds runs only for terminal sessions with active subprocesses", () => {
    const terminalRuns = buildTerminalProcessRuns({
      projects: [project],
      threads: [thread()],
      sessions: [
        {
          target: {
            environmentId: EnvironmentId.make("env-1"),
            threadId: ThreadId.make("thread-1"),
            terminalId: "term-1",
          },
          state: {
            summary: null,
            buffer: "",
            status: "running",
            error: null,
            hasRunningSubprocess: true,
            updatedAt: "2026-06-01T00:00:03.000Z",
            version: 1,
          },
        },
        {
          target: {
            environmentId: EnvironmentId.make("env-1"),
            threadId: ThreadId.make("thread-1"),
            terminalId: "term-2",
          },
          state: {
            summary: null,
            buffer: "",
            status: "running",
            error: null,
            hasRunningSubprocess: false,
            updatedAt: "2026-06-01T00:00:04.000Z",
            version: 1,
          },
        },
      ],
    });

    expect(terminalRuns).toHaveLength(1);
    expect(terminalRuns[0]?.session.target.terminalId).toBe("term-1");
    expect(terminalRuns[0]?.thread?.id).toBe("thread-1");
    expect(terminalRuns[0]?.project).toBe(project);
  });
});
