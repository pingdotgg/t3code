import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

type Session = Pick<
  EnvironmentThreadShell,
  "environmentId" | "projectId" | "id" | "title" | "createdAt" | "archivedAt"
>;

export function selectThreadSessionTabs<T extends Session>(
  threads: readonly T[],
  project: ScopedProjectRef,
  activeThreadId: ThreadId,
) {
  const sessions = threads
    .filter(
      (thread) =>
        thread.environmentId === project.environmentId &&
        thread.projectId === project.projectId &&
        (thread.archivedAt === null || thread.id === activeThreadId),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const recent = sessions.slice(-8);
  const active = sessions.find((thread) => thread.id === activeThreadId);
  return active && !recent.includes(active) ? [active, ...recent.slice(-7)] : recent;
}
