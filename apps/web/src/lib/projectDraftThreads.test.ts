import { describe, expect, it, vi } from "vitest";

import type { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  openOrReuseProjectDraftThread,
  type ProjectDraftThreadRecord,
} from "./projectDraftThreads";

const PROJECT_ID = "project-1" as ProjectId;
const CURRENT_THREAD_ID = "thread-current" as ThreadId;
const STORED_THREAD_ID = "thread-stored" as ThreadId;
const CREATED_THREAD_ID = "thread-created" as ThreadId;

describe("openOrReuseProjectDraftThread", () => {
  it("reuses the stored project draft thread and navigates to it", async () => {
    const setDraftThreadContext = vi.fn();
    const setProjectDraftThreadId = vi.fn();
    const clearProjectDraftThreadId = vi.fn();
    const navigateToThread = vi.fn(async () => {});
    const storedDraftThread: ProjectDraftThreadRecord = {
      threadId: STORED_THREAD_ID,
      projectId: PROJECT_ID,
      createdAt: "2026-03-11T10:00:00.000Z",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      envMode: "local",
    };

    const result = await openOrReuseProjectDraftThread({
      projectId: PROJECT_ID,
      currentThreadId: CURRENT_THREAD_ID,
      options: {
        branch: "feature/new-thread",
        envMode: "worktree",
      },
      getDraftThreadByProjectId: () => storedDraftThread,
      getDraftThread: () => null,
      setDraftThreadContext,
      setProjectDraftThreadId,
      clearProjectDraftThreadId,
      navigateToThread,
    });

    expect(result).toBe(STORED_THREAD_ID);
    expect(setDraftThreadContext).toHaveBeenCalledWith(STORED_THREAD_ID, {
      branch: "feature/new-thread",
      envMode: "worktree",
    });
    expect(setProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID, STORED_THREAD_ID);
    expect(clearProjectDraftThreadId).not.toHaveBeenCalled();
    expect(navigateToThread).toHaveBeenCalledWith(STORED_THREAD_ID);
  });

  it("reuses the current draft thread for the same project without navigating", async () => {
    const setDraftThreadContext = vi.fn();
    const setProjectDraftThreadId = vi.fn();
    const clearProjectDraftThreadId = vi.fn();
    const navigateToThread = vi.fn(async () => {});

    const result = await openOrReuseProjectDraftThread({
      projectId: PROJECT_ID,
      currentThreadId: CURRENT_THREAD_ID,
      options: {
        branch: null,
        worktreePath: "/repo/worktrees/feature",
        envMode: "worktree",
      },
      getDraftThreadByProjectId: () => null,
      getDraftThread: () => ({
        projectId: PROJECT_ID,
        createdAt: "2026-03-11T10:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        envMode: "local",
      }),
      setDraftThreadContext,
      setProjectDraftThreadId,
      clearProjectDraftThreadId,
      navigateToThread,
    });

    expect(result).toBe(CURRENT_THREAD_ID);
    expect(clearProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID);
    expect(setDraftThreadContext).toHaveBeenCalledWith(CURRENT_THREAD_ID, {
      branch: null,
      worktreePath: "/repo/worktrees/feature",
      envMode: "worktree",
    });
    expect(setProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID, CURRENT_THREAD_ID);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("creates and navigates to a fresh draft thread when none exists", async () => {
    const setDraftThreadContext = vi.fn();
    const setProjectDraftThreadId = vi.fn();
    const clearProjectDraftThreadId = vi.fn();
    const navigateToThread = vi.fn(async () => {});

    const result = await openOrReuseProjectDraftThread({
      projectId: PROJECT_ID,
      currentThreadId: CURRENT_THREAD_ID,
      options: {
        branch: "main",
        worktreePath: null,
        envMode: "local",
      },
      getDraftThreadByProjectId: () => null,
      getDraftThread: () => null,
      setDraftThreadContext,
      setProjectDraftThreadId,
      clearProjectDraftThreadId,
      navigateToThread,
      createThreadId: () => CREATED_THREAD_ID,
      now: () => "2026-03-11T11:00:00.000Z",
    });

    expect(result).toBe(CREATED_THREAD_ID);
    expect(clearProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID);
    expect(setDraftThreadContext).not.toHaveBeenCalled();
    expect(setProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID, CREATED_THREAD_ID, {
      createdAt: "2026-03-11T11:00:00.000Z",
      branch: "main",
      worktreePath: null,
      envMode: "local",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(navigateToThread).toHaveBeenCalledWith(CREATED_THREAD_ID);
  });
});
