import type {
  ApplicationStoredEvent,
  OrchestrationV2ThreadShell,
  RunId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  StorageCleanup,
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
  worktreeOwner,
  worktreeSettlementChain,
} from "../../storageCleanup.ts";
import * as CodeIntelligence from "./CodeIntelligence.ts";
import { checkoutPathKey } from "./codeIndexLayout.ts";

// An index is a cache the next agent run rebuilds, so an unused one is not worth its disk.
const UNUSED_INDEX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a worktree's index can go: its threads are idle, and either settled, with a subagent or
 * side chat following its owner rather than holding the worktree open, or long unused.
 */
export function worktreeIndexReleasable(
  group: ReadonlyArray<OrchestrationV2ThreadShell>,
  now: number,
  settings: Parameters<typeof storageCleanupThreadIdle>[2],
  threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map(
    group.map((thread) => [thread.id, thread]),
  ),
): boolean {
  if (group.length === 0) return false;
  const owner = worktreeOwner(group);
  const keptGoing = group.some(
    (t) => t.settledAt === null && (t.settledOverride === "active" || t.pinnedAt != null),
  );
  // A subagent or side-chat chain follows its owner; unrelated threads must all be settled.
  const settled =
    owner !== undefined
      ? worktreeSettlementChain(owner, threadsById, now, settings).length > 0 && !keptGoing
      : group.every((t) => t.settledAt !== null);
  const unused =
    !keptGoing && group.every((t) => now - storageCleanupActivityAt(t) >= UNUSED_INDEX_MS);
  return (settled || unused) && group.every((t) => storageCleanupThreadIdle(t, now, settings));
}

/**
 * Keeps the code index in step with the work happening in a checkout: a project indexes when it
 * is added, a worktree while an agent runs in it, and a worktree's index goes when its thread
 * settles or goes unused. Each Maintenance run also sweeps, dropping indexes for checkouts that no
 * longer exist even while automatic indexing is off.
 */
const make = Effect.gen(function* () {
  const storageCleanup = yield* StorageCleanup;
  const codeIntelligence = yield* CodeIntelligence.CodeIntelligence;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  const autoIndexEnabled = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.autoCodeIndexEnabled),
    Effect.orElseSucceed(() => false),
  );

  const releaseWorktreeIndex = Effect.fn("CodeIndexReactor.releaseWorktreeIndex")(function* (
    worktreePath: string,
  ) {
    if (!(yield* autoIndexEnabled)) return;
    const target = path.resolve(worktreePath);
    const entries = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    const group = (yield* Effect.forEach(
      entries.filter(
        (entry) => checkoutPathKey(path.resolve(entry.worktreePath)) === checkoutPathKey(target),
      ),
      (entry) => projections.getThreadShell(entry.threadId),
    )).filter((thread) => thread !== null);
    const threadsById = new Map(group.map((thread) => [thread.id, thread]));
    for (const thread of group) {
      let current = thread;
      while (current.settledAt === null && current.lineage.relationshipToParent === "subagent") {
        const parentId = current.lineage.parentThreadId;
        if (parentId === null || threadsById.has(parentId)) break;
        const parent = yield* projections.getThreadShell(parentId);
        if (parent === null) break;
        threadsById.set(parent.id, parent);
        current = parent;
      }
    }
    const settings = yield* settingsService.getSettings;
    const now = yield* Clock.currentTimeMillis;
    if (!worktreeIndexReleasable(group, now, settings, threadsById)) return;
    // A worktree registered as its own project keeps its index.
    const projects = yield* projectStore.listShells();
    if (
      projects.some(
        (project) =>
          checkoutPathKey(path.resolve(project.workspaceRoot)) === checkoutPathKey(target),
      )
    )
      return;
    yield* codeIntelligence.removeCheckoutIndex(target);
  });

  const sweep = Effect.fn("CodeIndexReactor.sweep")(function* () {
    const entries = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    // `listShells` omits deleted projects, so a deleted project is not a known checkout.
    const projects = yield* projectStore.listShells();
    const known = new Map(
      [
        ...projects.map((project) => project.workspaceRoot),
        ...entries.map((e) => e.worktreePath),
      ].map((knownPath) => {
        const resolved = path.resolve(knownPath);
        return [checkoutPathKey(resolved), resolved];
      }),
    );
    // Even with automatic indexing off: these only clean up T3's own data.
    yield* codeIntelligence.removeLegacyIndexes([...known.values()]);
    yield* codeIntelligence.removeOrphanedIndexes((checkoutPath) =>
      known.has(checkoutPathKey(path.resolve(checkoutPath))),
    );
    if (!(yield* autoIndexEnabled)) return;
    // De-duplicated first: hundreds of threads share a path, and each check hits the disk.
    const candidates = new Map(
      entries.map((entry) => {
        const resolved = path.resolve(entry.worktreePath);
        return [checkoutPathKey(resolved), resolved];
      }),
    );
    // Sequentially: each release waits on the checkout's build lock.
    for (const worktreePath of candidates.values()) {
      if (!(yield* codeIntelligence.hasCheckoutIndex(worktreePath))) continue;
      yield* releaseWorktreeIndex(worktreePath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("code index sweep failed for a worktree", { worktreePath, cause }),
        ),
      );
    }
  });

  // Only a run's first `running` counts: its status flips during approvals, and each request can
  // spawn a process.
  const activeRuns = new Map<ThreadId, RunId>();

  const refreshRun = Effect.fn("CodeIndexReactor.refreshRun")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null) return;
    yield* codeIntelligence.refreshForActiveAgent({ projectId: thread.projectId, threadId });
  });

  const releaseSettled = Effect.fn("CodeIndexReactor.releaseSettled")(function* (
    threadId: ThreadId,
    settledWorktreePath: string | null,
  ) {
    const shell = yield* projections.getThreadShell(threadId);
    const worktreePath = shell?.worktreePath ?? settledWorktreePath;
    if (worktreePath === null) return;
    yield* releaseWorktreeIndex(worktreePath);
  });

  const handle = (
    stored: ApplicationStoredEvent,
  ): Effect.Effect<
    void,
    ProjectionStore.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error | ServerSettingsError
  > => {
    // Most of the stream is turn items; a plain switch keeps those free.
    if (!("event" in stored)) {
      return stored.type === "project.created"
        ? codeIntelligence.ensureProjectIndexed(stored.payload.projectId)
        : Effect.void;
    }
    const event = stored.event;
    if (event.type === "thread.settled") {
      activeRuns.delete(event.payload.id);
      return releaseSettled(event.payload.id, event.payload.worktreePath);
    }
    if (event.type !== "run.created" && event.type !== "run.updated") return Effect.void;
    const run = event.payload;
    if (run.status !== "running" || activeRuns.get(run.threadId) === run.id) return Effect.void;
    activeRuns.set(run.threadId, run.id);
    return refreshRun(run.threadId);
  };
  const guarded = (stored: ApplicationStoredEvent) =>
    // One unreadable thread must not end indexing for every later event.
    handle(stored).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to handle a code indexing event", { cause }),
      ),
    );

  const afterSequence = yield* events.latestApplicationSequence;
  yield* forkParked(
    Stream.runForEach(events.streamApplicationEvents({ afterSequence }), guarded).pipe(
      Effect.catchCause((cause) => Effect.logWarning("code index event stream failed", { cause })),
    ),
  );

  // Every Maintenance run, "Delete now" included. The stream starts with the latest report, so
  // this also sweeps at activation.
  yield* forkParked(
    Stream.runForEach(storageCleanup.reports, () =>
      sweep().pipe(
        Effect.catchCause((cause) => Effect.logWarning("code index sweep failed", { cause })),
      ),
    ),
  );

  let lastAutoIndex = yield* autoIndexEnabled;
  const changes = yield* settingsService.subscribeChanges;
  yield* forkParked(
    Stream.runForEach(changes, (settings) => {
      const enabled = settings.autoCodeIndexEnabled;
      const wasEnabled = lastAutoIndex;
      lastAutoIndex = enabled;
      // Turning it off stops builds already running; turning it on waits for the next turn.
      return wasEnabled && !enabled ? codeIntelligence.stopBuilds : Effect.void;
    }),
  );
});

export const layer = Layer.effectDiscard(make);
