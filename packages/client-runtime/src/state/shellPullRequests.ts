import {
  OrchestrationV2ShellSnapshot,
  type ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * A shell snapshot whose threads may arrive before their pull request links are decoded. Those
 * links are most of a large shell's decode cost and only feed PR badges, so the thread list
 * can paint first. `loadPullRequests` then decodes the links by thread id; until it runs,
 * those threads carry no `pullRequests`.
 */
export interface DeferredShellSnapshot extends OrchestrationV2ShellSnapshot {
  readonly loadPullRequests?: Effect.Effect<
    ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>
  >;
}

// A zero sleep is a microtask yield, which on React Native runs before the next frame.
// A 1ms sleep takes a host timer, so the rows can render before the deferred decode.
const yieldToHost = Effect.sleep("1 millis");

const decodeThreadLinks = Schema.decodeUnknownEffect(
  Schema.UndefinedOr(Schema.toCodecJson(Schema.Array(ThreadPullRequestLink))),
);
// Bounds each uninterrupted stretch of decoding, so taps and frames run between batches.
const LINKS_PER_BATCH = 400;

/**
 * Removes each parsed thread row's pull request links from `snapshot` in place and returns
 * them in row order, for `deferPullRequests` once the rows are decoded.
 */
export function detachPullRequests(snapshot: unknown): ReadonlyArray<unknown> {
  if (!Predicate.isObject(snapshot)) return [];
  const rows: unknown = snapshot.threads;
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => {
    if (!Predicate.isObject(row)) return undefined;
    const links = row.pullRequests;
    delete row.pullRequests;
    return links;
  });
}

/**
 * Attaches a `loadPullRequests` that decodes the detached links after yielding to the host.
 * A thread whose links cannot be read gets none; its row stays usable.
 */
export function deferPullRequests<S extends OrchestrationV2ShellSnapshot>(
  snapshot: S,
  rawLinks: ReadonlyArray<unknown>,
): S & Required<Pick<DeferredShellSnapshot, "loadPullRequests">> {
  const threadIds = snapshot.threads.map((thread) => thread.id);
  // Schema decoding runs when called, so each thread's decode is built after a yield.
  const loadPullRequests = Effect.gen(function* () {
    const linksByThreadId = new Map<ThreadId, ReadonlyArray<ThreadPullRequestLink>>();
    let batchSize = LINKS_PER_BATCH;
    for (const [index, threadId] of threadIds.entries()) {
      const raw = rawLinks[index];
      if (raw === undefined) continue;
      const size = Array.isArray(raw) ? raw.length : 1;
      if (batchSize + size > LINKS_PER_BATCH) {
        yield* yieldToHost;
        batchSize = 0;
      }
      batchSize += size;
      // An unreadable thread keeps no links; the others still fill in.
      const links = yield* decodeThreadLinks(raw).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Discarding unreadable shell pull request links.", {
            threadId,
            cause: String(cause),
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (links !== undefined) linksByThreadId.set(threadId, links);
    }
    return linksByThreadId as ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>;
  });
  return { ...snapshot, loadPullRequests };
}

const decodeShellSnapshotJson = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ShellSnapshot),
);

/** Decodes a JSON shell snapshot with its threads' pull request links deferred. */
export const decodeShellSnapshotDeferringPullRequests = Effect.fnUntraced(function* (
  json: unknown,
) {
  const rawLinks = detachPullRequests(json);
  const snapshot = yield* decodeShellSnapshotJson(json);
  return deferPullRequests(snapshot, rawLinks);
});
