import { scopeProjectRef } from "@forma/client-runtime";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@forma/contracts";
import type { SidebarThreadSortOrder } from "@forma/contracts/settings";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { getLatestThreadForProject, type ThreadSortInput } from "./threadSort";
import type { Project, SidebarThreadSummary } from "../types";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ): Promise<void>;
}

type NewThreadOptions = NonNullable<Parameters<NewThreadHandler>[1]>;

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly handleNewThread: NewThreadHandler;
}

type OpenProjectThreadContext = Pick<
  ChatThreadActionContext,
  "defaultThreadEnvMode" | "handleNewThread"
>;

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

function buildContextualThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
  };
}

function buildDefaultThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    envMode: context.defaultThreadEnvMode,
  };
}

export async function startNewThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  await context.handleNewThread(projectRef, buildContextualThreadOptions(context));
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await startNewThreadInProjectFromContext(context, projectRef);
  return true;
}

export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef, buildDefaultThreadOptions(context));
  return true;
}

export async function openProjectOrCreateThread<
  TProject extends Pick<Project, "environmentId" | "id">,
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "id" | "projectId" | "archivedAt"> &
    ThreadSortInput,
>(input: {
  project: TProject;
  threads: readonly TThread[];
  sortOrder: SidebarThreadSortOrder;
  context: OpenProjectThreadContext;
  openThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
}): Promise<void> {
  const latestThread = getLatestThreadForProject(input.threads, input.project.id, input.sortOrder);
  if (latestThread) {
    await input.openThread(latestThread);
    return;
  }

  await input.context.handleNewThread(
    scopeProjectRef(input.project.environmentId, input.project.id),
    {
      envMode: input.context.defaultThreadEnvMode,
    },
  );
}
