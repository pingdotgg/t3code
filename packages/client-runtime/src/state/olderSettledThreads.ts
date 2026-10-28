import {
  isOlderSettledThreadShell,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2OlderSettledCursor,
  type OrchestrationV2OlderSettledThreadsPage,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, selectEnvironmentQueryData } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { threadFamilyRead } from "./threadFamilies.ts";

// Rows per page of older settled threads: one "Show more" step of the Settled shelf.
const OLDER_SETTLED_PAGE_SIZE = 25;
// A burst of changes (a PR sync touching many old threads) costs one count read.
const COUNT_REREAD_DELAY = "500 millis";

/** Where an environment's shell cut settled threads, and how many are older per project. */
export interface OlderSettled {
  readonly before: string;
  readonly beforeMs: number;
  readonly counts: ReadonlyMap<ProjectId, number>;
}

/** The scope's projects in one environment, or null for all of them. */
export interface OlderSettledScope {
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId> | null;
}

/**
 * The pages read below an environment's cut. Everything at or above `frontier` is local: pages
 * hold the rows that were there when read, and shell deltas keep that range current. A null
 * frontier means no more can load: every older thread is loaded, or this session has no snapshot.
 */
export interface OlderSettledPages {
  readonly reads: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly frontier: OrchestrationV2OlderSettledCursor | null;
  readonly status: "ready" | "pending" | "failed";
}

const NO_PAGES: OlderSettledPages = { reads: [], frontier: null, status: "ready" };

type OlderSettledRow = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt"
>;

export interface OlderSettledShelfEnvironment {
  readonly older: OlderSettled | null;
  readonly pages: OlderSettledPages;
}

/**
 * Changes whenever the older count can: any removal (by largest sequence, so a repeat counts), an
 * older row that arrives or changes, or an old row arriving outside the set (unsettled). Threads
 * created after the cut never enter it, as threads settle after creation. Archived-thread events
 * arrive as removals too, each costing one count read.
 */
export function olderSettledCountKey(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  beforeMs: number,
  removedAt: ReadonlyMap<ThreadId, number>,
): string {
  let lastRemoval = 0;
  for (const sequence of removedAt.values()) lastRemoval = Math.max(lastRemoval, sequence);
  const rows: string[] = [];
  for (const thread of threads) {
    if (thread.lineage.relationshipToParent === "subagent") continue;
    const older = isOlderSettledThreadShell(thread, beforeMs);
    if (older || DateTime.toEpochMillis(thread.createdAt) < beforeMs) {
      rows.push(`${thread.id}:${older ? 1 : 0}`);
    }
  }
  return `${lastRemoval}|${rows.sort().join(",")}`;
}

/** Whether a row sits at or above a page cursor in the server's order (settle time desc, id asc). */
function atOrAboveCursor(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "settledAt">,
  cursor: OrchestrationV2OlderSettledCursor,
): boolean {
  if (thread.settledAt === null) return true;
  const settledAt = DateTime.formatIso(thread.settledAt);
  return !(
    settledAt < cursor.settledAt ||
    (cursor.threadId !== undefined && settledAt === cursor.settledAt && thread.id > cursor.threadId)
  );
}

/**
 * Where a shelf over these environments stops listing: the highest frontier of any environment
 * that can still load older threads (its cut until its first page). Rows below it could sort under
 * rows not loaded yet, so the merged list is a correct prefix even while a page loads. A failed
 * environment holds no one back; its Retry rejoins it.
 */
export function settledShelfFrontier(
  environments: ReadonlyArray<OlderSettledShelfEnvironment>,
): OrchestrationV2OlderSettledCursor | null {
  let highest: OrchestrationV2OlderSettledCursor | null = null;
  for (const { older, pages } of environments) {
    if (older === null || pages.frontier === null || pages.status === "failed") continue;
    const frontier = pages.frontier;
    // On a settle-time tie, a cursor with an id stops above one without, and a smaller id higher.
    if (
      highest === null ||
      frontier.settledAt > highest.settledAt ||
      (frontier.settledAt === highest.settledAt &&
        frontier.threadId !== undefined &&
        (highest.threadId === undefined || frontier.threadId < highest.threadId))
    ) {
      highest = frontier;
    }
  }
  return highest;
}

/**
 * Whether the Settled shelf may list a row: at or above the shelf's frontier. So a row that turns
 * older mid-session (a backdated auto-settle, a snooze that ends, an unarchive) waits for the
 * range that holds it.
 */
export function isListedSettledThread(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "settledAt">,
  frontier: OrchestrationV2OlderSettledCursor | null,
): boolean {
  return frontier === null || atOrAboveCursor(thread, frontier);
}

/**
 * Older settled threads in scope that this client does not hold: the server's counts minus the
 * older rows it has. Add it to the local rows for the Settled label or a project's thread count.
 */
export function unloadedOlderSettledCount(input: {
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** Every row the client holds in scope, in any section. */
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly source: OlderSettledRow;
  }>;
}): number {
  let unloaded = 0;
  for (const scope of input.scopes) {
    const older = input.olderSettled(scope.environmentId);
    if (older === null) continue;
    if (scope.projectIds === null) {
      for (const count of older.counts.values()) unloaded += count;
    } else {
      for (const projectId of scope.projectIds) unloaded += older.counts.get(projectId) ?? 0;
    }
    for (const thread of input.threads) {
      if (
        thread.environmentId === scope.environmentId &&
        (scope.projectIds === null || scope.projectIds.includes(thread.source.projectId)) &&
        isOlderSettledThreadShell(thread.source, older.beforeMs)
      ) {
        unloaded -= 1;
      }
    }
  }
  return Math.max(0, unloaded);
}

/**
 * The pages each environment should read: while the shelf lists fewer than `visibleCount` rows,
 * one more for each environment whose frontier is the shelf's, once its pages have loaded. A
 * short page ends an environment's chain; counts can lag a backdated settle, so they do not gate.
 */
export function wantedOlderSettledPages(input: {
  readonly requested: ReadonlyMap<EnvironmentId, number>;
  readonly environments: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>;
  readonly listedCount: number;
  readonly visibleCount: number;
}): ReadonlyMap<EnvironmentId, number> {
  if (input.listedCount >= input.visibleCount) return input.requested;
  const frontier = settledShelfFrontier([...input.environments.values()]);
  if (frontier === null) return input.requested;
  let next: Map<EnvironmentId, number> | null = null;
  for (const [environmentId, { older, pages }] of input.environments) {
    if (older === null || pages.status !== "ready" || pages.frontier === null) continue;
    if (
      pages.frontier.settledAt !== frontier.settledAt ||
      pages.frontier.threadId !== frontier.threadId
    ) {
      continue;
    }
    next ??= new Map(input.requested);
    next.set(environmentId, (input.requested.get(environmentId) ?? 0) + 1);
  }
  return next ?? input.requested;
}

/**
 * Shells that omit older settled threads (`omitOlderSettled`) name the cut and count what they left
 * out. These atoms keep those counts current and read older threads in pages for the Settled shelf.
 */
export function createOlderSettledThreadAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  const shellStateValue = (state: AsyncResult.AsyncResult<EnvironmentShellState, E>) =>
    AsyncResult.getOrElse(state, () => null);

  const countReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-counts",
    staleTimeMs: Number.POSITIVE_INFINITY,
    // A newer key unmounts this read; with no idle time its wait is interrupted before the RPC.
    idleTtlMs: 0,
    execute: Effect.fn("OlderSettledThreads.readCounts")(function* (input: {
      readonly generation: number;
      readonly before: string;
      readonly key: string;
    }) {
      yield* Effect.sleep(COUNT_REREAD_DELAY);
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, {
        before: { settledAt: input.before },
        limit: 0,
      });
    }),
  });

  const pageReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-page",
    staleTimeMs: Number.POSITIVE_INFINITY,
    // A collapsed shelf keeps no read alive, as an idle one runs again when a reconnect replaces
    // the session.
    idleTtlMs: 0,
    execute: Effect.fn("OlderSettledThreads.readPage")(function* (input: {
      readonly generation: number;
      readonly projectIds: ReadonlyArray<ProjectId> | null;
      readonly before: OrchestrationV2OlderSettledCursor;
    }) {
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, {
        before: input.before,
        ...(input.projectIds === null ? {} : { projectIds: input.projectIds }),
        limit: OLDER_SETTLED_PAGE_SIZE,
      });
    }),
  });

  const countsOf = (source: {
    readonly counts: OrchestrationV2OlderSettledThreadsPage["counts"];
  }) => new Map(source.counts.map(({ projectId, count }) => [projectId, count] as const));

  const olderSettledAtom = Atom.family((environmentId: EnvironmentId) => {
    let generation = -1;
    // The key of the first state seen this generation, when that state is the snapshot itself.
    let snapshotKey: string | null = null;
    let keyInputs: { readonly threads: unknown; readonly removedAt: unknown } | null = null;
    let key = "";
    let fromSnapshot: OlderSettled | null = null;
    let lastRead: OlderSettled | null = null;
    let lastReadPage: OrchestrationV2OlderSettledThreadsPage | null = null;
    return Atom.make((get): OlderSettled | null => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const cut = snapshot?.olderSettled;
      if (state === null || snapshot === null || cut === undefined) return null;
      if (fromSnapshot?.before !== cut.before || state.generation !== generation) {
        fromSnapshot = {
          before: cut.before,
          beforeMs: DateTime.toEpochMillis(DateTime.makeUnsafe(cut.before)),
          counts: countsOf(cut),
        };
      }
      // Most shell updates move only the cursor; the key needs new rows or removals.
      if (keyInputs?.threads !== snapshot.threads || keyInputs.removedAt !== state.removedAt) {
        keyInputs = { threads: snapshot.threads, removedAt: state.removedAt };
        key = olderSettledCountKey(snapshot.threads, fromSnapshot.beforeMs, state.removedAt);
      }
      if (state.generation !== generation) {
        generation = state.generation;
        snapshotKey = snapshot.snapshotSequence === cut.asOfSequence ? key : null;
        lastRead = null;
      }
      // Generation 0 is a cached shell: no reads until this session's first snapshot.
      if (key === snapshotKey || state.generation === 0) return fromSnapshot;
      const read = selectEnvironmentQueryData(
        get(
          countReadAtom({
            environmentId,
            input: { generation: state.generation, before: cut.before, key },
          }),
        ),
      );
      if (read !== null && read !== lastReadPage) {
        lastReadPage = read;
        lastRead = { ...fromSnapshot, counts: countsOf(read) };
      }
      return lastRead ?? fromSnapshot;
    }).pipe(Atom.withLabel(`environment-older-settled:${environmentId}`));
  });

  const pagesKey = (scope: OlderSettledScope, pages: number) =>
    JSON.stringify([
      scope.environmentId,
      scope.projectIds === null ? null : [...scope.projectIds].sort(),
      pages,
    ]);

  const pagesAtom = Atom.family((key: string) => {
    const [environmentId, projectIds, pages] = JSON.parse(key) as [
      EnvironmentId,
      ReadonlyArray<ProjectId> | null,
      number,
    ];
    let previous = NO_PAGES;
    const keep = (next: OlderSettledPages): OlderSettledPages => {
      const same =
        next.status === previous.status &&
        next.frontier?.settledAt === previous.frontier?.settledAt &&
        next.frontier?.threadId === previous.frontier?.threadId &&
        (next.frontier === null) === (previous.frontier === null) &&
        next.reads.length === previous.reads.length &&
        next.reads.every((read, index) => read === previous.reads[index]);
      if (!same) previous = next;
      return previous;
    };
    return Atom.make((get) => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const cut = state === null ? undefined : Option.getOrNull(state.snapshot)?.olderSettled;
      // A cached shell (an environment not connected yet, or offline) must not hold the shelf
      // back for other environments, so it lists what it holds until its first snapshot.
      if (state === null || cut === undefined || state.generation === 0) return keep(NO_PAGES);
      let frontier: OrchestrationV2OlderSettledCursor = { settledAt: cut.before };
      if (pages === 0) return keep({ reads: [], frontier, status: "ready" });
      const reads: OrchestrationV2ThreadFamily[] = [];
      for (let index = 0; index < pages; index += 1) {
        const result = get(
          pageReadAtom({
            environmentId,
            input: { generation: state.generation, projectIds, before: frontier },
          }),
        );
        const page = selectEnvironmentQueryData(result);
        if (page === null) {
          return keep({
            reads,
            frontier,
            status: threadFamilyRead(result) === "failed" ? "failed" : "pending",
          });
        }
        reads.push(page);
        const last = page.threads.at(-1);
        if (page.threads.length < OLDER_SETTLED_PAGE_SIZE || last?.settledAt == null) {
          return keep({ reads, frontier: null, status: "ready" });
        }
        frontier = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id };
      }
      return keep({ reads, frontier, status: "ready" });
    }).pipe(Atom.withLabel(`environment-older-settled-pages:${key}`));
  });

  const pageRowsAtom = Atom.family((key: string) =>
    Atom.map(pagesAtom(key), (pages) => pages.reads).pipe(
      Atom.withLabel(`environment-older-settled-page-rows:${key}`),
    ),
  );

  const searchGenerationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): number | "waiting" | "none" => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      if (state !== null && state.generation > 0) return state.generation;
      return state?.status === "synchronizing" ? "waiting" : "none";
    }),
  );
  const searchReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-search",
    idleTtlMs: 60_000,
    execute: Effect.fn("OlderSettledThreads.search")(function* (input: {
      readonly generation: number;
      readonly search: OrchestrationV2SearchThreadsInput;
    }) {
      return yield* request(ORCHESTRATION_V2_WS_METHODS.searchThreads, input.search);
    }),
  });
  // Keyed by shell generation like pages: rows read before a new snapshot do not merge, so the
  // search reads them again.
  const searchAtom = Atom.family((key: string) => {
    const [environmentId, search] = JSON.parse(key) as [
      EnvironmentId,
      OrchestrationV2SearchThreadsInput,
    ];
    return Atom.make((get) => {
      const generation = get(searchGenerationAtom(environmentId));
      // Nothing is read before this session's first snapshot, which would drop the rows. It shows
      // as loading only while that snapshot is on its way, so an offline environment never spins.
      return typeof generation === "number"
        ? get(searchReadAtom({ environmentId, input: { generation, search } }))
        : AsyncResult.initial(generation === "waiting");
    }).pipe(Atom.withLabel(`environment-older-settled-search:${key}`));
  });

  // One read for a shelf that spans environments: each one's cut, counts and pages.
  const shelfAtom = Atom.family((key: string) => {
    const entries = JSON.parse(key) as ReadonlyArray<readonly [string, string]>;
    let previous: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> = new Map();
    return Atom.make((get): ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> => {
      const shelf = new Map<EnvironmentId, OlderSettledShelfEnvironment>();
      let changed = previous.size !== entries.length;
      for (const [environmentId, pagesKey] of entries) {
        const older = get(olderSettledAtom(environmentId as EnvironmentId));
        const pages = get(pagesAtom(pagesKey));
        const prior = previous.get(environmentId as EnvironmentId);
        changed ||= prior?.older !== older || prior.pages !== pages;
        shelf.set(environmentId as EnvironmentId, { older, pages });
      }
      if (changed) previous = shelf;
      return previous;
    }).pipe(Atom.withLabel(`environment-older-settled-shelf:${key}`));
  });

  /** Reads a failed page again (a no-op when none failed); the pages after it follow. */
  const retryPages = (
    registry: AtomRegistry.AtomRegistry,
    scope: OlderSettledScope,
    pages: number,
  ) => {
    const state = shellStateValue(registry.get(shellStateAtom(scope.environmentId)));
    const result = registry.get(pagesAtom(pagesKey(scope, pages)));
    if (state === null || result.status !== "failed" || result.frontier === null) return;
    registry.refresh(
      pageReadAtom({
        environmentId: scope.environmentId,
        input: {
          generation: state.generation,
          projectIds: scope.projectIds === null ? null : [...scope.projectIds].sort(),
          before: result.frontier,
        },
      }),
    );
  };

  return {
    /** The environment's cut and current counts, or null when its shell keeps every settled thread. */
    olderSettledAtom,
    /** Each scope's cut, counts and first `pages` pages. */
    shelfAtom: (
      scopes: ReadonlyArray<{ readonly scope: OlderSettledScope; readonly pages: number }>,
    ) =>
      shelfAtom(
        JSON.stringify(
          scopes.map(({ scope, pages }) => [scope.environmentId, pagesKey(scope, pages)] as const),
        ),
      ),
    retryPages,
    /** The first `pages` pages below the cut for one scope, read in order. */
    pagesAtom: (scope: OlderSettledScope, pages: number) => pagesAtom(pagesKey(scope, pages)),
    /** Their rows, for `createThreadFamilyAtoms(...).mountRows`, under `rowsKey`. */
    pageRowsAtom: (scope: OlderSettledScope, pages: number) => pageRowsAtom(pagesKey(scope, pages)),
    rowsKey: (scope: OlderSettledScope, pages: number) => `older-settled:${pagesKey(scope, pages)}`,
    /** `orchestration.searchThreads` for a search that asks for older settled rows. */
    searchAtom: (environmentId: EnvironmentId, search: OrchestrationV2SearchThreadsInput) =>
      searchAtom(JSON.stringify([environmentId, search])),
  };
}
