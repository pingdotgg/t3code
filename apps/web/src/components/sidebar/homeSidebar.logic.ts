import {
  isHomeThreadId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

// Home has its own sidebar entry, so its thread and the project that holds it leave the lists.

export function withoutHomeThreads<Thread extends { readonly id: ThreadId }>(
  threads: readonly Thread[],
): readonly Thread[] {
  return threads.some((thread) => isHomeThreadId(thread.id))
    ? threads.filter((thread) => !isHomeThreadId(thread.id))
    : threads;
}

export function withoutHomeProjects<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  projects: readonly Project[],
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
  }>,
): readonly Project[] {
  const homeProjectKeys = new Set(
    threads
      .filter((thread) => isHomeThreadId(thread.id))
      .map((thread) => `${thread.environmentId}:${thread.projectId}`),
  );
  return homeProjectKeys.size === 0
    ? projects
    : projects.filter((project) => !homeProjectKeys.has(`${project.environmentId}:${project.id}`));
}
