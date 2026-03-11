import type { ProjectId, RuntimeMode, ThreadId, WorktreeId } from "@repo/contracts";
import type { DraftThreadEnvMode, DraftThreadState } from "../composerDraftStore";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { newThreadId } from "./utils";

type WorktreeDraftThread = DraftThreadState & { threadId: ThreadId };

interface EnsureWorktreeDraftThreadInput {
  projectId: ProjectId;
  worktreeId: WorktreeId;
  routeThreadId?: ThreadId | null;
  branch?: string | null | undefined;
  worktreePath?: string | null | undefined;
  envMode?: DraftThreadEnvMode | undefined;
  getDraftThreadByWorktreeId: (worktreeId: WorktreeId) => WorktreeDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setWorktreeDraftThreadId: (
    worktreeId: WorktreeId,
    threadId: ThreadId,
    options: {
      projectId: ProjectId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      worktreeId?: WorktreeId | null;
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      envMode?: DraftThreadEnvMode;
    },
  ) => void;
  now?: () => string;
}

export function ensureWorktreeDraftThread(input: EnsureWorktreeDraftThreadInput): ThreadId {
  const worktreePath = input.worktreePath ?? null;
  const envMode = input.envMode ?? (worktreePath ? "worktree" : "local");
  const branch = input.branch ?? null;
  const createdAt = input.now?.() ?? new Date().toISOString();

  const storedDraftThread = input.getDraftThreadByWorktreeId(input.worktreeId);
  if (storedDraftThread) {
    input.setDraftThreadContext(storedDraftThread.threadId, {
      branch,
      worktreePath,
      envMode,
      worktreeId: input.worktreeId,
      projectId: input.projectId,
    });
    input.setWorktreeDraftThreadId(input.worktreeId, storedDraftThread.threadId, {
      projectId: input.projectId,
      branch,
      worktreePath,
      envMode,
    });
    return storedDraftThread.threadId;
  }

  const activeDraftThread = input.routeThreadId ? input.getDraftThread(input.routeThreadId) : null;
  if (
    activeDraftThread &&
    input.routeThreadId &&
    activeDraftThread.worktreeId === input.worktreeId
  ) {
    input.setDraftThreadContext(input.routeThreadId, {
      branch,
      worktreePath,
      envMode,
      worktreeId: input.worktreeId,
      projectId: input.projectId,
    });
    return input.routeThreadId;
  }

  const threadId = newThreadId();
  input.setWorktreeDraftThreadId(input.worktreeId, threadId, {
    projectId: input.projectId,
    createdAt,
    branch,
    worktreePath,
    envMode,
    runtimeMode: DEFAULT_RUNTIME_MODE,
  });
  return threadId;
}
