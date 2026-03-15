import type { ProjectId } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ): Promise<void>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly handleNewThread: NewThreadHandler;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
}

export function resolveThreadActionProjectId(context: ChatThreadActionContext): ProjectId | null {
  return (
    context.activeThread?.projectId ??
    context.activeDraftThread?.projectId ??
    context.projects[0]?.id ??
    null
  );
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectId = resolveThreadActionProjectId(context);
  if (!projectId) {
    return false;
  }

  await context.handleNewThread(projectId, {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
  });
  return true;
}

export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectId = resolveThreadActionProjectId(context);
  if (!projectId) {
    return false;
  }

  await context.handleNewThread(projectId, {
    envMode: context.defaultThreadEnvMode,
  });
  return true;
}
