import type { ProjectId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";

import type { DraftThreadEnvMode, DraftThreadState } from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";

export interface ProjectDraftThreadRecord extends DraftThreadState {
  threadId: ThreadId;
}

export interface ProjectDraftThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  createdAt?: string;
}

interface OpenOrReuseProjectDraftThreadInput {
  projectId: ProjectId;
  currentThreadId: ThreadId | null;
  options?: ProjectDraftThreadOptions;
  getDraftThreadByProjectId: (projectId: ProjectId) => ProjectDraftThreadRecord | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setDraftThreadContext: (threadId: ThreadId, options: ProjectDraftThreadOptions) => void;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: ProjectDraftThreadOptions,
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  navigateToThread: (threadId: ThreadId) => Promise<void>;
  createThreadId?: () => ThreadId;
  now?: () => string;
}

function hasDraftThreadOptions(options: ProjectDraftThreadOptions | undefined): boolean {
  return (
    options?.branch !== undefined ||
    options?.worktreePath !== undefined ||
    options?.envMode !== undefined ||
    options?.runtimeMode !== undefined ||
    options?.interactionMode !== undefined ||
    options?.createdAt !== undefined
  );
}

function buildDraftThreadContextUpdate(
  options: ProjectDraftThreadOptions | undefined,
): ProjectDraftThreadOptions | null {
  if (!hasDraftThreadOptions(options)) {
    return null;
  }

  return {
    ...(options?.branch !== undefined ? { branch: options.branch ?? null } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath ?? null } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.runtimeMode !== undefined ? { runtimeMode: options.runtimeMode } : {}),
    ...(options?.interactionMode !== undefined ? { interactionMode: options.interactionMode } : {}),
    ...(options?.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
  };
}

export async function openOrReuseProjectDraftThread(
  input: OpenOrReuseProjectDraftThreadInput,
): Promise<ThreadId> {
  const update = buildDraftThreadContextUpdate(input.options);
  const storedDraftThread = input.getDraftThreadByProjectId(input.projectId);

  if (storedDraftThread) {
    if (update) {
      input.setDraftThreadContext(storedDraftThread.threadId, update);
    }
    input.setProjectDraftThreadId(input.projectId, storedDraftThread.threadId);
    if (input.currentThreadId !== storedDraftThread.threadId) {
      await input.navigateToThread(storedDraftThread.threadId);
    }
    return storedDraftThread.threadId;
  }

  input.clearProjectDraftThreadId(input.projectId);

  if (input.currentThreadId) {
    const activeDraftThread = input.getDraftThread(input.currentThreadId);
    if (activeDraftThread?.projectId === input.projectId) {
      if (update) {
        input.setDraftThreadContext(input.currentThreadId, update);
      }
      input.setProjectDraftThreadId(input.projectId, input.currentThreadId);
      return input.currentThreadId;
    }
  }

  const threadId = (input.createThreadId ?? newThreadId)();
  input.setProjectDraftThreadId(input.projectId, threadId, {
    createdAt: input.options?.createdAt ?? (input.now ?? (() => new Date().toISOString()))(),
    branch: input.options?.branch ?? null,
    worktreePath: input.options?.worktreePath ?? null,
    envMode: input.options?.envMode ?? "local",
    runtimeMode: input.options?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.options?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  await input.navigateToThread(threadId);
  return threadId;
}
