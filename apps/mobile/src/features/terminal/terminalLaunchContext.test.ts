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
        launchAllowed: true,
        terminalLocation: { cwd: "/old-primary", worktreePath: null },
        activeSessionLocation: null,
        workspaceRoot: "/new-primary",
        threadShellWorktreePath: "/member-worktree",
        threadDetailWorktreePath: "/member-detail",
      }),
    ).toEqual({ cwd: "/old-primary", worktreePath: null });
    expect(
      resolveTerminalOpenLocation({
        launchAllowed: true,
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
        launchAllowed: true,
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
        launchAllowed: true,
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

import { ProjectId } from "@t3tools/contracts";
import { resolveWorkbench } from "@t3tools/client-runtime/state/task-workbench";
import { pendingTerminalLaunchMatchesWorkbench } from "./terminalLaunchContext";

it("cancels staged script input when the scoped primary project changes or becomes unavailable", () => {
  const environmentId = EnvironmentId.make("environment");
  const taskRef = { environmentId, taskId: TaskId.make("task") };
  const project = { environmentId, id: ProjectId.make("primary"), workspaceRoot: "/primary" };
  const input = {
    threadRef: null,
    thread: null,
    taskRef,
    task: { ...taskRef, id: taskRef.taskId, primaryProjectId: project.id },
    tasksSupported: true,
    authoritative: true,
    projects: [project],
  };
  const workbench = resolveWorkbench(input);
  if (workbench.status !== "ready") throw new Error("Expected task workbench");
  const launch = {
    projectRef: workbench.projectRef,
    projectCwd: "/primary",
    cwd: "/primary",
    worktreePath: null,
    initialInput: "dev\r",
  };
  expect(pendingTerminalLaunchMatchesWorkbench(launch, workbench)).toBe(true);
  expect(
    pendingTerminalLaunchMatchesWorkbench(
      launch,
      resolveWorkbench({ ...input, authoritative: false }),
    ),
  ).toBe(false);
  expect(
    pendingTerminalLaunchMatchesWorkbench(
      launch,
      resolveWorkbench({ ...input, projects: [{ ...project, workspaceRoot: "/new-primary" }] }),
    ),
  ).toBe(false);
  expect(
    pendingTerminalLaunchMatchesWorkbench(launch, resolveWorkbench({ ...input, task: null })),
  ).toBe(false);
  expect(
    pendingTerminalLaunchMatchesWorkbench(
      {
        ...launch,
        projectRef: { ...workbench.projectRef, environmentId: EnvironmentId.make("other") },
      },
      workbench,
    ),
  ).toBe(false);
});

it("never captures a cached root for a fresh terminal but retains existing sessions", () => {
  const cached = {
    launchAllowed: false,
    terminalLocation: null,
    activeSessionLocation: null,
    workspaceRoot: "/cached-primary",
    threadShellWorktreePath: null,
    threadDetailWorktreePath: null,
  };
  expect(resolveTerminalOpenLocation(cached)).toBeNull();
  expect(
    resolveTerminalOpenLocation({
      ...cached,
      activeSessionLocation: { cwd: "/existing-pty", worktreePath: null },
    }),
  ).toEqual({ cwd: "/existing-pty", worktreePath: null });
  expect(
    resolveTerminalOpenLocation({ ...cached, launchAllowed: true, workspaceRoot: "/live-primary" }),
  ).toEqual({ cwd: "/live-primary", worktreePath: null });
});
