import type { OrbitThreadIndex, OrbitThreadIndexRow } from "./client.ts";
import type { OrbitInstanceThreadInput } from "./instanceList.ts";

/**
 * Conn (thread-index plan, C3): the Gateway's thread index (`GET /conn/threads`). With the flag
 * `connAttachedServers` on, a container server this device holds off (park reason `not-attached`
 * or `asleep`) shows its threads from the index instead of a connection; every other server keeps
 * its live (or cached) rows. Flag off: nothing here is called.
 */

/** What a device keeps of the index: per server, the rows of its newest good read. */
export interface OrbitThreadIndexState {
  readonly servers: ReadonlyMap<
    string,
    { readonly readAt: string | null; readonly rows: readonly OrbitThreadIndexRow[] }
  >;
}

export const EMPTY_ORBIT_THREAD_INDEX_STATE: OrbitThreadIndexState = { servers: new Map() };

const readAtMs = (readAt: string | null): number => {
  if (readAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(readAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/**
 * The kept index after a read. Freshness is the server's `read_at`: a server whose read failed
 * (`read_error`), or whose `read_at` is older than the kept one, keeps its last rows and takes
 * nothing new. A server the answer no longer covers (destroyed, or out of this Node's access) goes.
 * A failed call (`null`) keeps everything as it was.
 */
export function nextOrbitThreadIndexState(
  previous: OrbitThreadIndexState,
  index: OrbitThreadIndex | null,
): OrbitThreadIndexState {
  if (index === null) return previous;
  const rowsByServer = new Map<string, OrbitThreadIndexRow[]>();
  for (const row of index.rows) {
    const rows = rowsByServer.get(row.environmentId) ?? [];
    rows.push(row);
    rowsByServer.set(row.environmentId, rows);
  }
  const servers = new Map<
    string,
    { readonly readAt: string | null; readonly rows: readonly OrbitThreadIndexRow[] }
  >();
  for (const server of index.environments) {
    const kept = previous.servers.get(server.environmentId);
    const stale =
      server.readError !== null ||
      (kept !== undefined && readAtMs(server.readAt) < readAtMs(kept.readAt));
    if (stale) {
      if (kept !== undefined) servers.set(server.environmentId, kept);
      continue;
    }
    servers.set(server.environmentId, {
      readAt: server.readAt,
      rows: rowsByServer.get(server.environmentId) ?? [],
    });
  }
  return { servers };
}

/** T3's active run statuses: a live row shows these as working (`threadRuntimeIsActive`). */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Subagent threads live inside their parent's view and have no list row. The index has no
 * lineage, so they are known by the ids T3 gives them (`IdAllocator`: `thread:subagent:<hash>`,
 * legacy `thread:provider:<driver>:…:native-thread:<id>`).
 */
export function isIndexSubagentThreadId(threadId: string): boolean {
  return threadId.startsWith("thread:subagent:") || threadId.startsWith("thread:provider:");
}

/** The later of two ISO times; either may be null. */
function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return readAtMs(right) > readAtMs(left) ? right : left;
}

/**
 * An index row in the list's row model. Last activity: the later of the last user message and the
 * last finished run ("" when neither). Working: only the statuses a live row shows as working, so
 * a thread that waits for the user (`waiting`) shows as it does live; `needs_input` is not used.
 */
export function orbitIndexThreadInput(row: OrbitThreadIndexRow): OrbitInstanceThreadInput {
  return {
    environmentId: row.environmentId,
    id: row.threadId,
    title: row.title,
    updatedAt: later(row.lastUserMessageAt, row.lastRunCompletedAt) ?? "",
    archivedAt: null,
    working: row.state !== null && ACTIVE_STATES.has(row.state),
  };
}

/**
 * The thread list the Orbit list joins. Flag off, or no server held off: `live` itself. Flag on:
 * each held-off server that the index covers shows its index rows in place of its live (cached)
 * rows; every other server keeps its live rows. One source per server, so a server that connects
 * (no longer held) shows its live rows only, never both.
 */
export function orbitThreadInputsWithIndex(input: {
  readonly enabled: boolean;
  readonly live: readonly OrbitInstanceThreadInput[];
  readonly index: OrbitThreadIndexState;
  /** Environments that hold at least one park reason now. */
  readonly held: ReadonlySet<string>;
}): readonly OrbitInstanceThreadInput[] {
  if (!input.enabled || input.held.size === 0) return input.live;
  const fromIndex = new Set(
    [...input.held].filter((environmentId) => input.index.servers.has(environmentId)),
  );
  if (fromIndex.size === 0) return input.live;
  const indexed = [...fromIndex].flatMap((environmentId) =>
    (input.index.servers.get(environmentId)?.rows ?? [])
      .filter((row) => !isIndexSubagentThreadId(row.threadId))
      .map(orbitIndexThreadInput),
  );
  return [...input.live.filter((thread) => !fromIndex.has(thread.environmentId)), ...indexed];
}

/**
 * One index read for the Orbit list. Called where the list itself is read, never on a timer of its
 * own. Flag off, or no server held off: no call. Null when there was no call or it failed; the
 * caller merges an answer into its CURRENT kept state (`nextOrbitThreadIndexState`), so a read
 * that answers after a newer one cannot undo it (the `read_at` check decides).
 */
export async function readOrbitThreadIndex(input: {
  readonly enabled: boolean;
  readonly held: ReadonlySet<string>;
  readonly threads: () => Promise<OrbitThreadIndex>;
}): Promise<OrbitThreadIndex | null> {
  if (!input.enabled || input.held.size === 0) return null;
  try {
    return await input.threads();
  } catch {
    return null;
  }
}
