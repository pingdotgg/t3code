import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { ThreadDetailsTooltip, ThreadDetailsTooltipProvider } from "./SidebarThreadTooltip";

vi.mock("./ui/tooltip", () => ({
  TooltipPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const thread: SidebarThreadSummary = {
  id: ThreadId.make("hover-thread"),
  environmentId: EnvironmentId.make("hover-environment"),
  projectId: ProjectId.make("hover-project"),
  parentThreadId: null,
  title: "Improve Codebase Architecture",
  interactionMode: "default",
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: "refactor/projection-reconciliation",
  worktreePath: "/worktrees/projection-reconciliation",
  pullRequest: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasPendingQueuedTurn: false,
};

describe("ThreadDetailsTooltip", () => {
  it("shows the worktree even when the project path is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailsTooltipProvider value={[thread]}>
        <ThreadDetailsTooltip
          thread={thread}
          projectName="t3code"
          projectCwd={null}
          environmentLabel={null}
          providerEntry={null}
          terminalProcessCount={0}
        />
      </ThreadDetailsTooltipProvider>,
    );

    expect(markup).toContain(thread.title);
    expect(markup).toContain(thread.branch);
    expect(markup).toContain(thread.worktreePath);
    expect(markup).not.toContain("terminal process");
  });

  it("preserves remote and terminal details and separates pull request state from its title", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailsTooltipProvider value={[thread]}>
        <ThreadDetailsTooltip
          thread={{
            ...thread,
            worktreePath: null,
            pullRequest: {
              number: 273,
              title: "Separate projection reconciliation",
              url: "https://example.test/pull/273",
              baseBranch: "main",
              headBranch: "refactor/projection-reconciliation",
              state: "merged",
            },
          }}
          projectName="t3code"
          projectCwd="/projects/t3code"
          environmentLabel="Build machine"
          providerEntry={null}
          terminalProcessCount={2}
        />
      </ThreadDetailsTooltipProvider>,
    );

    expect(markup).toContain("/projects/t3code");
    expect(markup).toContain("Build machine");
    expect(markup).toContain("2 terminal processes running");
    expect(markup).toContain("PR merged</div>");
    expect(markup).toContain("Separate projection reconciliation</div>");
  });

  it("renders three prioritized children, the total count, and parent blockers", () => {
    const children = [
      { ...thread, id: ThreadId.make("idle"), parentThreadId: thread.id, title: "Idle child" },
      {
        ...thread,
        id: ThreadId.make("working"),
        parentThreadId: thread.id,
        title: "Refactor projection queries",
        hasPendingQueuedTurn: true,
      },
      {
        ...thread,
        id: ThreadId.make("input"),
        parentThreadId: thread.id,
        title: "Review migration safety",
        hasPendingUserInput: true,
      },
      {
        ...thread,
        id: ThreadId.make("approval"),
        parentThreadId: thread.id,
        title: "Update regression coverage",
        hasPendingApprovals: true,
      },
    ];
    const markup = renderToStaticMarkup(
      <ThreadDetailsTooltipProvider value={[thread, ...children]}>
        <ThreadDetailsTooltip
          thread={{
            ...thread,
            hasPendingApprovals: true,
            latestChildNotificationAt: "2026-01-02T00:00:00.000Z",
          }}
          projectName="t3code"
          projectCwd={null}
          environmentLabel={null}
          providerEntry={null}
          terminalProcessCount={0}
        />
      </ThreadDetailsTooltipProvider>,
    );

    expect(markup).toContain("Waiting for approval");
    expect(markup).toContain("New child update");
    expect(markup).toContain('aria-label="Child chats"');
    expect(markup).toContain(">4</span>");
    expect(markup).toContain("Needs input");
    expect(markup).toContain("Working");
    expect(markup).toContain("+1 more");
    expect(markup).not.toContain("Idle child");
    expect(markup.indexOf("Review migration safety")).toBeLessThan(
      markup.indexOf("Refactor projection queries"),
    );
  });
});
