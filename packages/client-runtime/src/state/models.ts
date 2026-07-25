import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentThreadShell extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export type EnvironmentMessage = OrchestrationMessage;

export interface EnvironmentThread extends OrchestrationThread {
  readonly environmentId: EnvironmentId;
}

/**
 * The reserved Chat pseudo-project hosts one-off conversations with no
 * real codebase behind them, so project-scoped surfaces (diff, files,
 * branches, worktrees, terminal, git actions) are hidden for it.
 */
export function isChatsProject(
  project: Pick<OrchestrationProjectShell, "kind"> | null | undefined,
): boolean {
  return project?.kind === "chats";
}

/**
 * Label shown wherever the Chat pseudo-project is named. Overriding the
 * stored title keeps already-created projects consistent with the current
 * wording without a data migration.
 */
export const CHATS_PROJECT_LABEL = "Chat";

export function projectDisplayTitle(
  project: Pick<OrchestrationProjectShell, "kind" | "title">,
): string {
  return isChatsProject(project) ? CHATS_PROJECT_LABEL : project.title;
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentThreadShell {
  return { ...thread, environmentId };
}

export function scopeThread(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThread {
  return { ...thread, environmentId };
}

export function selectEnvironmentThreadShell(
  snapshot: OrchestrationShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? scopeThreadShell(environmentId, thread) : null;
}
