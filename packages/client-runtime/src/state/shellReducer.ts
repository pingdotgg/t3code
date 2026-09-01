import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

/**
 * Re-partitions active/archive membership from each thread's `archivedAt`.
 * Defends against stale full snapshots or mis-tagged deltas that would otherwise
 * keep an archived thread on the home list.
 */
export function normalizeShellThreadMembership(
  snapshot: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  const byId = new Map<string, OrchestrationV2ThreadShell>();

  const updatedAtMs = (thread: OrchestrationV2ThreadShell): number => {
    const value = thread.updatedAt as unknown;
    if (DateTime.isDateTime(value)) {
      return DateTime.toEpochMillis(value);
    }
    return Date.parse(String(value));
  };

  const preferFresher = (
    existing: OrchestrationV2ThreadShell | undefined,
    candidate: OrchestrationV2ThreadShell,
  ): OrchestrationV2ThreadShell => {
    if (existing === undefined) {
      return candidate;
    }
    const existingMs = updatedAtMs(existing);
    const candidateMs = updatedAtMs(candidate);
    if (Number.isNaN(existingMs) || Number.isNaN(candidateMs)) {
      return existing;
    }
    // Strictly newer wins. On equal timestamps keep the first copy so a stale
    // archive row cannot beat a same-time active unarchive (and vice versa only
    // when the archive row is actually fresher).
    return candidateMs > existingMs ? candidate : existing;
  };

  for (const thread of snapshot.threads) {
    byId.set(String(thread.id), preferFresher(byId.get(String(thread.id)), thread));
  }
  for (const thread of snapshot.archivedThreads) {
    byId.set(String(thread.id), preferFresher(byId.get(String(thread.id)), thread));
  }

  const threads: OrchestrationV2ThreadShell[] = [];
  const archivedThreads: OrchestrationV2ThreadShell[] = [];
  for (const thread of byId.values()) {
    if (thread.archivedAt !== null) {
      archivedThreads.push(thread);
    } else {
      threads.push(thread);
    }
  }

  if (
    threads.length === snapshot.threads.length &&
    archivedThreads.length === snapshot.archivedThreads.length &&
    threads.every((thread, index) => thread === snapshot.threads[index]) &&
    archivedThreads.every((thread, index) => thread === snapshot.archivedThreads[index])
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    threads,
    archivedThreads,
  };
}

function retainRepositoryIdentity(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    return { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  return next;
}

export interface MergeShellSnapshotOptions {
  /**
   * Metadata-only enrichment refresh: structure and sequence never change;
   * listed roots accept identity exactly (including null).
   * Omit this options object for authoritative HTTP/initial WebSocket snapshots.
   */
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}

/**
 * Merge an incoming full shell snapshot into prior client state.
 *
 * Authoritative snapshots (no options) replace structure and sequence even when
 * lower than cache, while retaining a prior non-null identity when the candidate
 * is still unresolved/null for the same root.
 *
 * Enrichment snapshots (options present) only patch repository identity for
 * matching current projects. They never replace projects, threads, archives,
 * or sequence, regardless of the incoming snapshot sequence.
 */
export function mergeShellSnapshotProjects(
  previous: OrchestrationV2ShellSnapshot | null | undefined,
  next: OrchestrationV2ShellSnapshot,
  options?: MergeShellSnapshotOptions,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous === undefined) {
    return next;
  }

  const isEnrichment = options !== undefined;
  const resolvedRootSet = isEnrichment ? new Set(options.resolvedRepositoryIdentityRoots) : null;

  if (isEnrichment) {
    const nextById = new Map(next.projects.map((project) => [project.id, project] as const));
    return {
      ...previous,
      projects: previous.projects.map((project) => {
        const candidate = nextById.get(project.id);
        if (candidate === undefined || candidate.workspaceRoot !== project.workspaceRoot) {
          return project;
        }
        if (resolvedRootSet?.has(project.workspaceRoot) === true) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        if (project.repositoryIdentity == null && candidate.repositoryIdentity != null) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        return project;
      }),
    };
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  return {
    ...next,
    projects: next.projects.map((project) => {
      const prior = previousById.get(project.id);
      if (resolvedRootSet?.has(project.workspaceRoot) === true) {
        return project;
      }
      return retainRepositoryIdentity(prior, project);
    }),
  };
}

/** Applies one committed V2 shell delta while preserving active/archive exclusivity. */
export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Exclude<
    OrchestrationV2ShellStreamItem,
    { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
  >,
): OrchestrationV2ShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated": {
      // Enrichment is async. A project mutation can land with null
      // repositoryIdentity while an earlier snapshot already resolved it.
      // Keep the prior identity for the same workspace root so multi-env
      // grouping does not split until a full snapshot refresh arrives.
      const previous = snapshot.projects.find((project) => project.id === event.project.id);
      const project = retainRepositoryIdentity(previous, event.project);
      return {
        ...snapshot,
        projects: upsertById(snapshot.projects, project),
        snapshotSequence: event.sequence,
      };
    }
    case "project.removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread.updated": {
      // Trust archivedAt over location so a mis-tagged active delta cannot keep
      // an archived thread on the home list after another client archives it.
      const location = event.thread.archivedAt !== null ? "archive" : event.location;
      const withoutThread = (threads: OrchestrationV2ShellSnapshot["threads"]) =>
        threads.filter((thread) => thread.id !== event.thread.id);
      return normalizeShellThreadMembership({
        ...snapshot,
        threads:
          location === "active"
            ? upsertById(withoutThread(snapshot.threads), event.thread)
            : withoutThread(snapshot.threads),
        // The archive has its own bounded query/subscription. Older servers may
        // still send archive-located deltas here; remove them from the normal
        // shell instead of growing its persisted cache again.
        archivedThreads: withoutThread(snapshot.archivedThreads),
        snapshotSequence: event.sequence,
      });
    }
    case "thread.removed":
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        archivedThreads: snapshot.archivedThreads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
