import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { prStatusIndicator, resolveTerminalThreadRef } from "./ThreadStatusIndicators";
import type { SidebarThreadSummary } from "../types";

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");

function thread(id: string, input: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId,
    projectId,
    parentThreadId: null,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("resolveTerminalThreadRef", () => {
  it("uses the virtual agent's parent thread for terminal state", () => {
    const parentThreadId = ThreadId.make("thread-parent");
    const virtualThread = thread("agent-run-thread", {
      virtualAgentRun: {
        parentThreadId,
        taskId: "task-1",
        status: "completed",
      },
    });

    expect(resolveTerminalThreadRef(virtualThread)).toEqual(
      scopeThreadRef(environmentId, parentThreadId),
    );
  });

  it("uses the thread id for normal rows", () => {
    const regularThread = thread("thread-1");

    expect(resolveTerminalThreadRef(regularThread)).toEqual(
      scopeThreadRef(environmentId, regularThread.id),
    );
  });
});

describe("prStatusIndicator", () => {
  const pr = {
    number: 137,
    title: "Add sidebar filter",
    url: "https://example.test/pr/137",
    baseBranch: "main",
    headBranch: "feat/sidebar-filter",
  };

  it("exposes the number for each state alongside its own colour", () => {
    // The sidebar renders `#number` inline instead of an icon, so the number
    // has to survive on the indicator and stay colour-coded by state.
    const states = [
      { state: "open", colorClass: "text-emerald-600 dark:text-emerald-300/90" },
      { state: "closed", colorClass: "text-zinc-500 dark:text-zinc-400/80" },
      { state: "merged", colorClass: "text-violet-600 dark:text-violet-300/90" },
    ] as const;

    for (const { state, colorClass } of states) {
      const indicator = prStatusIndicator({ ...pr, state });
      expect(indicator).toMatchObject({ number: 137, colorClass, url: pr.url });
    }
  });

  it("returns null without a pull request", () => {
    expect(prStatusIndicator(null)).toBeNull();
  });
});
