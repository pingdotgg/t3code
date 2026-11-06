import {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  RepositoryIdentity,
  ThreadPullRequestLink,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const sameThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);
const sameProjectShell = Schema.toEquivalence(OrchestrationProjectShell);
const sameLinks = Schema.toEquivalence(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink)));
const sameRepositoryIdentity = Schema.toEquivalence(
  Schema.UndefinedOr(Schema.NullOr(RepositoryIdentity)),
);

export function sameThreadPullRequests(
  left: OrchestrationV2ThreadShell["pullRequests"],
  right: OrchestrationV2ThreadShell["pullRequests"],
): boolean {
  return left === right || sameLinks(left, right);
}

/**
 * Links are compared apart from the rest of the row because a deferred snapshot arrives without
 * them; such a row keeps its links until they fill in.
 */
export function reuseUnchangedThreadShells(
  previous: OrchestrationV2ShellSnapshot | null,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous.threads.length === 0) return next;
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread] as const));
  let changed = false;
  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);
    if (prior === undefined) return thread;
    const candidate =
      thread.pullRequests === undefined && prior.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    const retained = sameThreadShell(prior, candidate) ? prior : candidate;
    if (retained !== thread) changed = true;
    return retained;
  });
  return changed ? { ...next, threads } : next;
}

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
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
    const projects = previous.projects.map((project) => {
      const candidate = nextById.get(project.id);
      if (candidate === undefined || candidate.workspaceRoot !== project.workspaceRoot) {
        return project;
      }
      if (resolvedRootSet?.has(project.workspaceRoot) === true) {
        // Refreshes re-resolve every root; an unchanged identity keeps the project's identity
        // so every subscriber (each pull request row, the sidebar) skips re-rendering.
        if (sameRepositoryIdentity(project.repositoryIdentity, candidate.repositoryIdentity)) {
          return project;
        }
        return { ...project, repositoryIdentity: candidate.repositoryIdentity };
      }
      if (project.repositoryIdentity == null && candidate.repositoryIdentity != null) {
        return { ...project, repositoryIdentity: candidate.repositoryIdentity };
      }
      return project;
    });
    return projects.every((project, index) => project === previous.projects[index])
      ? previous
      : { ...previous, projects };
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  // Project atoms and shell persistence compare by reference, so unchanged projects keep their objects.
  const projects = next.projects.map((project) => {
    const prior = previousById.get(project.id);
    const merged = retainRepositoryIdentity(prior, project);
    return prior !== undefined && sameProjectShell(prior, merged) ? prior : merged;
  });
  const unchanged =
    projects.length === previous.projects.length &&
    projects.every((project, index) => project === previous.projects[index]);
  return { ...next, projects: unchanged ? previous.projects : projects };
}

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
      const existing =
        event.location === "active"
          ? snapshot.threads.find((thread) => thread.id === event.thread.id)
          : undefined;
      if (existing !== undefined && sameThreadShell(existing, event.thread)) {
        return { ...snapshot, snapshotSequence: event.sequence };
      }
      const withoutThread = (threads: OrchestrationV2ShellSnapshot["threads"]) =>
        threads.filter((thread) => thread.id !== event.thread.id);
      return {
        ...snapshot,
        threads:
          event.location === "active"
            ? upsertById(snapshot.threads, event.thread)
            : withoutThread(snapshot.threads),
        // The archive has its own bounded query/subscription. Older servers may
        // still send archive-located deltas here; remove them from the normal
        // shell instead of growing its persisted cache again.
        archivedThreads: withoutThread(snapshot.archivedThreads),
        snapshotSequence: event.sequence,
      };
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

/** Index a collection lazily and materialize it only if a delta changes its rows. */
function batchRows<T extends { readonly id: unknown }>(rows: ReadonlyArray<T>) {
  let byId: Map<T["id"], T> | undefined;
  let changed = false;
  const index = () => {
    if (byId === undefined) {
      byId = new Map();
      for (const row of rows) byId.set(row.id, row);
    }
    return byId;
  };
  return {
    get: (id: T["id"]) => index().get(id),
    set: (row: T) => {
      index().set(row.id, row);
      changed = true;
    },
    remove: (id: T["id"]) => {
      if (index().delete(id)) changed = true;
    },
    finish: () => (changed ? Array.from(index().values()) : rows),
  };
}

export type ShellStreamEvent = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

/** Apply ordered deltas with one index and at most one new array per collection. */
export function applyShellStreamEvents(
  snapshot: OrchestrationV2ShellSnapshot,
  events: ReadonlyArray<ShellStreamEvent>,
): OrchestrationV2ShellSnapshot {
  // Avoid indexing the whole shell for the common single-event delivery.
  if (events.length === 1) return applyShellStreamEvent(snapshot, events[0]!);
  const projects = batchRows(snapshot.projects);
  const threads = batchRows(snapshot.threads);
  const archivedThreads = batchRows(snapshot.archivedThreads);
  let sequence = snapshot.snapshotSequence;
  for (const event of events) {
    if (event.sequence <= sequence) continue;
    switch (event.kind) {
      case "project.updated":
        projects.set(retainRepositoryIdentity(projects.get(event.project.id), event.project));
        break;
      case "project.removed":
        projects.remove(event.projectId);
        break;
      case "thread.updated": {
        const id = event.thread.id;
        if (event.location === "active") {
          const previous = threads.get(id);
          if (previous !== undefined && sameThreadShell(previous, event.thread)) break;
          threads.set(event.thread);
        } else {
          threads.remove(id);
        }
        // Legacy archive deltas remove rows from the shell; the archive is queried separately.
        archivedThreads.remove(id);
        break;
      }
      case "thread.removed":
        threads.remove(event.threadId);
        archivedThreads.remove(event.threadId);
        break;
      default:
        continue;
    }
    sequence = event.sequence;
  }
  if (sequence === snapshot.snapshotSequence) return snapshot;
  return {
    ...snapshot,
    snapshotSequence: sequence,
    projects: projects.finish(),
    threads: threads.finish(),
    archivedThreads: archivedThreads.finish(),
  };
}
