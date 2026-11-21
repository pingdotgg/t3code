import {
  isHomeThreadId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

// Home has its own sidebar entry, so its thread, its crew and the project that holds it leave the
// lists. Home's crew shows under that entry instead.

type HomeListedThread = {
  readonly id: ThreadId;
  readonly groupedUnderThreadId?: ThreadId | null | undefined;
};

const belongsToHome = (thread: HomeListedThread) =>
  isHomeThreadId(thread.id) ||
  (thread.groupedUnderThreadId != null && isHomeThreadId(thread.groupedUnderThreadId));

export function withoutHomeThreads<Thread extends HomeListedThread>(
  threads: readonly Thread[],
): readonly Thread[] {
  return threads.some(belongsToHome) ? threads.filter((thread) => !belongsToHome(thread)) : threads;
}

/** Home's threads and its crew, which the Home entry shows. */
export function homeThreads<Thread extends HomeListedThread>(
  threads: readonly Thread[],
): readonly Thread[] {
  return threads.filter(belongsToHome);
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
