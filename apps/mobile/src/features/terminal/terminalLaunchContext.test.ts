import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { taskWorkbenchRef } from "@t3tools/client-runtime/state/task-workbench";

import {
  resolvePreferredThreadWorktreePath,
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolvePreferredThreadWorktreePath", () => {
  it("prefers thread detail worktree paths over thread shell paths", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/root",
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("falls back to the thread shell worktree path when detail is unavailable", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/worktrees/feature",
        threadDetailWorktreePath: null,
      }),
    ).toBe("/repo/worktrees/feature");
  });
});

describe("resolveTerminalOpenLocation", () => {
  it("keeps an existing task PTY at its old root after a primary project edit", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: { cwd: "/old-primary", worktreePath: null },
        activeSessionLocation: null,
        workspaceRoot: "/new-primary",
        threadShellWorktreePath: "/member-worktree",
        threadDetailWorktreePath: "/member-detail",
      }),
    ).toEqual({ cwd: "/old-primary", worktreePath: null });
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/new-primary",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: null,
      }),
    ).toEqual({ cwd: "/new-primary", worktreePath: null });
  });
  it("uses the thread detail worktree path before the workspace root for a fresh mobile open", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/other",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });
});

describe("pending terminal launches", () => {
  it("consumes a sibling launch through the task owner without crossing environments", () => {
    const owner = taskWorkbenchRef({
      environmentId: EnvironmentId.make("one"),
      taskId: TaskId.make("shared"),
    });
    const target = { ...owner, terminalId: "task-launch" };
    stagePendingTerminalLaunch({ target, launch: { cwd: "/primary", worktreePath: null } });
    expect(
      takePendingTerminalLaunch({ ...target, environmentId: EnvironmentId.make("two") }),
    ).toBeNull();
    expect(takePendingTerminalLaunch({ ...target, threadId: ThreadId.make("member") })).toBeNull();
    expect(takePendingTerminalLaunch(target)?.cwd).toBe("/primary");
  });
  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });

  it("keeps pending launches isolated per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-3",
    };

    stagePendingTerminalLaunch({
      target: primaryTarget,
      launch: {
        cwd: "/repo/root",
        worktreePath: null,
        initialInput: "pnpm i\r",
      },
    });

    expect(takePendingTerminalLaunch(otherTarget)).toBeNull();
    expect(takePendingTerminalLaunch(primaryTarget)).toEqual({
      cwd: "/repo/root",
      worktreePath: null,
      env: undefined,
      initialInput: "pnpm i\r",
    });
  });
});
