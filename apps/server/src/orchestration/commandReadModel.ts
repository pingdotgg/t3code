import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";

/**
 * Server-internal representation of the orchestration read model.
 *
 * Unlike the wire {@link OrchestrationReadModel} (which uses arrays and is
 * produced by the DB-backed `ProjectionSnapshotQuery`), this model is only ever
 * touched by the single serial command-worker fiber in `OrchestrationEngine`.
 * It uses persistent `HashMap`s keyed by id so the projector and command
 * invariants get O(1)-ish lookups and single-key updates instead of O(N)
 * array scans and full-array copies on every event.
 *
 * The model is never serialized or sent over the wire, so its shape can evolve
 * independently of the contract.
 */
export interface CommandReadModel {
  readonly snapshotSequence: number;
  readonly projects: HashMap.HashMap<ProjectId, OrchestrationProject>;
  readonly threads: HashMap.HashMap<ThreadId, OrchestrationThread>;
  /**
   * Ids of threads that have been deleted. Deleted threads are evicted from
   * `threads` (freeing their message/activity/checkpoint arrays), but their id
   * is retained here so `requireThreadAbsent` still rejects re-creating a
   * thread with a previously-used id — the "cannot be created twice" invariant
   * the DB projection also upholds (its tombstone row is never removed).
   */
  readonly deletedThreadIds: HashSet.HashSet<ThreadId>;
  readonly updatedAt: string;
}

export function createEmptyCommandReadModel(nowIso: string): CommandReadModel {
  return {
    snapshotSequence: 0,
    projects: HashMap.empty<ProjectId, OrchestrationProject>(),
    threads: HashMap.empty<ThreadId, OrchestrationThread>(),
    deletedThreadIds: HashSet.empty<ThreadId>(),
    updatedAt: nowIso,
  };
}

/**
 * Whether a thread id has been used and deleted. Used by `requireThreadAbsent`
 * so an evicted (deleted) thread's id cannot be re-created.
 */
export function isThreadDeleted(model: CommandReadModel, threadId: ThreadId): boolean {
  return HashSet.has(model.deletedThreadIds, threadId);
}

/**
 * Seed a {@link CommandReadModel} from the array-based wire read model produced
 * by `ProjectionSnapshotQuery.getCommandReadModel()` at engine boot.
 *
 * Deleted threads are dropped so the in-memory model starts consistent with the
 * projector's eviction policy (deleted threads are removed, archived threads are
 * retained). The DB projection remains the source of truth for deleted rows.
 */
export function fromWireReadModel(
  model: OrchestrationReadModel,
  options?: { readonly dropDeletedThreads?: boolean },
): CommandReadModel {
  const dropDeletedThreads = options?.dropDeletedThreads ?? true;
  const threads = dropDeletedThreads
    ? model.threads.filter((thread) => thread.deletedAt === null)
    : model.threads;
  // Retain the ids of deleted threads so the create-twice invariant survives
  // a restart even though the (evicted) thread bodies are not loaded.
  const deletedThreadIds = HashSet.fromIterable(
    model.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
  );
  return {
    snapshotSequence: model.snapshotSequence,
    updatedAt: model.updatedAt,
    projects: HashMap.fromIterable(model.projects.map((project) => [project.id, project] as const)),
    threads: HashMap.fromIterable(threads.map((thread) => [thread.id, thread] as const)),
    deletedThreadIds,
  };
}

export function findThreadById(
  model: CommandReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return Option.getOrUndefined(HashMap.get(model.threads, threadId));
}

export function findProjectById(
  model: CommandReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return Option.getOrUndefined(HashMap.get(model.projects, projectId));
}

export function listThreadsByProjectId(
  model: CommandReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  const result: OrchestrationThread[] = [];
  for (const thread of HashMap.values(model.threads)) {
    if (thread.projectId === projectId) {
      result.push(thread);
    }
  }
  // HashMap iteration order is not insertion order; sort by creation time (then
  // id) so callers observe a stable, deterministic order — matching the prior
  // array-backed behavior. Only used by the rare `project.delete` fan-out.
  return result.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}
