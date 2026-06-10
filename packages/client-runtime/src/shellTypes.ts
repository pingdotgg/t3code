import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

export interface EnvironmentScopedProjectShell extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentScopedThreadShell extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export function scopeProjectShell(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentScopedProjectShell {
  return { ...project, environmentId };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentScopedThreadShell {
  return { ...thread, environmentId };
}

export function selectScopedThreadShell(
  snapshot: OrchestrationShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentScopedThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? scopeThreadShell(environmentId, thread) : null;
}
