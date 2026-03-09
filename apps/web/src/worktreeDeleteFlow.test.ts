import { ThreadId, type NativeApi } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { deleteThreadWorktree } from "./worktreeDeleteFlow";

function createNativeApiMock() {
  return {
    projects: {
      runLifecycleScript: vi.fn(async () => undefined),
    },
    terminal: {
      close: vi.fn(async () => undefined),
    },
  };
}

describe("deleteThreadWorktree", () => {
  it("runs the delete hook before closing terminals and removing the worktree", async () => {
    const callOrder: string[] = [];
    const api = createNativeApiMock();
    api.projects.runLifecycleScript.mockImplementation(async () => {
      callOrder.push("hook");
    });
    api.terminal.close.mockImplementation(async () => {
      callOrder.push("terminal.close");
    });
    const removeWorktree = vi.fn(async () => {
      callOrder.push("worktree.remove");
    });

    await deleteThreadWorktree({
      api: api as unknown as NativeApi,
      thread: { id: ThreadId.makeUnsafe("thread-1") },
      project: {
        cwd: "/repo/project",
        scripts: [
          {
            id: "cleanup",
            name: "Cleanup",
            command: "git pull --ff-only",
            icon: "configure",
            runOnWorktreeCreate: false,
            runOnWorktreeDelete: true,
          },
        ],
      },
      worktreePath: "/repo/worktrees/thread-1",
      removeWorktree,
    });

    expect(api.projects.runLifecycleScript).toHaveBeenCalledWith({
      cwd: "/repo/worktrees/thread-1",
      command: "git pull --ff-only",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/thread-1",
      },
    });
    expect(api.terminal.close).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      path: "/repo/worktrees/thread-1",
      force: true,
    });
    expect(callOrder).toEqual(["hook", "terminal.close", "worktree.remove"]);
  });

  it("skips the delete hook when no action owns the delete slot", async () => {
    const api = createNativeApiMock();
    const removeWorktree = vi.fn(async () => undefined);

    await deleteThreadWorktree({
      api: api as unknown as NativeApi,
      thread: { id: ThreadId.makeUnsafe("thread-1") },
      project: {
        cwd: "/repo/project",
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
            runOnWorktreeDelete: false,
          },
        ],
      },
      worktreePath: "/repo/worktrees/thread-1",
      removeWorktree,
    });

    expect(api.projects.runLifecycleScript).not.toHaveBeenCalled();
    expect(api.terminal.close).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("aborts before closing terminals when the delete hook fails", async () => {
    const api = createNativeApiMock();
    api.projects.runLifecycleScript.mockRejectedValue(new Error("hook failed"));
    const removeWorktree = vi.fn(async () => undefined);

    await expect(
      deleteThreadWorktree({
        api: api as unknown as NativeApi,
        thread: { id: ThreadId.makeUnsafe("thread-1") },
        project: {
          cwd: "/repo/project",
          scripts: [
            {
              id: "cleanup",
              name: "Cleanup",
              command: "git pull --ff-only",
              icon: "configure",
              runOnWorktreeCreate: false,
              runOnWorktreeDelete: true,
            },
          ],
        },
        worktreePath: "/repo/worktrees/thread-1",
        removeWorktree,
      }),
    ).rejects.toThrow("hook failed");

    expect(api.terminal.close).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("propagates worktree removal failures after the hook and terminal close complete", async () => {
    const callOrder: string[] = [];
    const api = createNativeApiMock();
    api.projects.runLifecycleScript.mockImplementation(async () => {
      callOrder.push("hook");
    });
    api.terminal.close.mockImplementation(async () => {
      callOrder.push("terminal.close");
    });
    const removeWorktree = vi.fn(async () => {
      callOrder.push("worktree.remove");
      throw new Error("remove failed");
    });

    await expect(
      deleteThreadWorktree({
        api: api as unknown as NativeApi,
        thread: { id: ThreadId.makeUnsafe("thread-1") },
        project: {
          cwd: "/repo/project",
          scripts: [
            {
              id: "cleanup",
              name: "Cleanup",
              command: "git pull --ff-only",
              icon: "configure",
              runOnWorktreeCreate: false,
              runOnWorktreeDelete: true,
            },
          ],
        },
        worktreePath: "/repo/worktrees/thread-1",
        removeWorktree,
      }),
    ).rejects.toThrow("remove failed");

    expect(callOrder).toEqual(["hook", "terminal.close", "worktree.remove"]);
  });
});
