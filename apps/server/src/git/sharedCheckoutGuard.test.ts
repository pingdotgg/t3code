import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { busyThreadsInCheckout, describeBusyCheckout } from "./sharedCheckoutGuard.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

const thread = (
  title: string,
  overrides: {
    readonly projectId?: ProjectId;
    readonly worktreePath?: string | null;
    readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
  } = {},
) => ({
  id: ThreadId.make(title),
  title,
  projectId: overrides.projectId ?? projectId,
  worktreePath: overrides.worktreePath ?? null,
  activityRunStatus:
    overrides.activityRunStatus === undefined ? "running" : overrides.activityRunStatus,
});

describe("busyThreadsInCheckout", () => {
  it("finds running local threads in the project root checkout", () => {
    const busy = busyThreadsInCheckout({
      cwd: "/repo",
      projectId,
      threads: [
        thread("local running"),
        thread("local idle", { activityRunStatus: null }),
        thread("worktree running", { worktreePath: "/worktrees/a" }),
        thread("other project", { projectId: otherProjectId }),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["local running"]);
  });

  it("finds running threads that share a worktree", () => {
    const busy = busyThreadsInCheckout({
      cwd: "/worktrees/a",
      projectId: null,
      threads: [
        thread("same worktree", { worktreePath: "/worktrees/a", activityRunStatus: "waiting" }),
        thread("other worktree", { worktreePath: "/worktrees/b" }),
        thread("local running"),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["same worktree"]);
  });
});

describe("describeBusyCheckout", () => {
  it("names the busy threads", () => {
    expect(describeBusyCheckout(["Fix login"])).toBe(
      "'Fix login' is still working in this checkout. Wait for it to finish, or use a worktree for a separate branch.",
    );
    expect(describeBusyCheckout(["A", "B", "C", "D"])).toBe(
      "'A', 'B' and 2 more are still working in this checkout. Wait for them to finish, or use a worktree for a separate branch.",
    );
  });
});
