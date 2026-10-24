import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  foldSearchQuery,
  THREAD_OPEN_DEDUPE_MS,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";

import type { EnvironmentThreadShell } from "./models.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

// When this client last sent an open per thread, by its own clock: a server
// timestamp would be off by any clock skew. The server merges opens closer
// together than THREAD_OPEN_DEDUPE_MS anyway, so skipping them saves a command
// and a broadcast while flipping between threads.
const sentThreadOpens = new Map<string, number>();
// When this client last opened each thread, sent or not, so recent threads
// follow quick switches the server merges.
const localThreadOpens = new Map<string, number>();
/**
 * Records that this client opened a thread, and says whether to send the open
 * to the server now.
 */
export function claimThreadOpen(environmentId: EnvironmentId, threadId: string, now: number) {
  const key = `${environmentId}:${threadId}`;
  localThreadOpens.set(key, now);
  if (now - (sentThreadOpens.get(key) ?? Number.NEGATIVE_INFINITY) < THREAD_OPEN_DEDUPE_MS) {
    return false;
  }
  sentThreadOpens.set(key, now);
  return true;
}

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(...value.matches.map((match) => ({ ...match, environmentId })));
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}

export type ThreadSearchShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "branch"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
  | "opens"
> &
  Partial<Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">>;

/**
 * What the web and mobile palettes rank a thread shell by. Pass the
 * environment label only when there are two or more environments.
 */
export function threadSearchSubject(
  thread: ThreadSearchShell,
  projectTitle: string | null | undefined,
  environmentLabel?: string | null,
): ThreadSearchSubject {
  // What the user wrote, not agent wakes or task notices in the user role. A
  // thread the user never wrote in counts from its creation; an older server
  // omits the field, so the latest user-role message stands in.
  const authored = thread.latestUserAuthoredMessageAt;
  const activityAt =
    authored === undefined
      ? getThreadSortTimestamp(thread, "updated_at")
      : Date.parse(authored ?? thread.createdAt);
  const localOpenedAt = localThreadOpens.get(`${thread.environmentId}:${thread.id}`) ?? 0;
  return {
    id: thread.id,
    title: thread.title,
    branch: thread.branch,
    projectTitle: projectTitle ?? null,
    environmentLabel: environmentLabel ?? null,
    pullRequests: threadSearchPullRequests(thread),
    activityAt: Number.isFinite(activityAt) ? activityAt : null,
    // This client's own latest open counts too: the server merged it, or has
    // no record yet (an older server ignores opens).
    opens:
      localOpenedAt > (thread.opens?.openedAt ?? 0)
        ? { score: 1, picks: [], ...thread.opens, openedAt: localOpenedAt }
        : (thread.opens ?? null),
  };
}

/** Message result keys in the order a search box last showed them for `query`. */
export interface ShownOrder {
  readonly query: string;
  readonly keys: ReadonlyArray<string>;
  /** How many of `keys` are on screen; only those hold their places. */
  readonly shown: number;
}

// Rows past the limit a slower environment's best matches may take.
const LATE_ROOM = 3;

/**
 * The order to show message results in, and how many: rows already shown for
 * this query keep their places, and results that arrive later, from a slower
 * environment, go below them with up to LATE_ROOM rows past `limit`. Nothing
 * moves under the pointer or the keyboard highlight, and a late best match
 * still shows. Returns `previous` when nothing changed, so it can sit in React
 * state.
 */
export function nextShownOrder(
  previous: ShownOrder | null,
  query: string,
  ranked: ReadonlyArray<string>,
  limit: number,
): ShownOrder {
  if (previous?.query !== query) {
    return { query, keys: ranked, shown: Math.min(limit, ranked.length) };
  }
  const listed = new Set(ranked);
  const kept = previous.keys.slice(0, previous.shown).filter((key) => listed.has(key));
  const held = new Set(kept);
  const seen = new Set(previous.keys);
  const rest = ranked.filter((key) => !held.has(key));
  const arrived = rest.filter((key) => !seen.has(key)).length;
  const keys = [...kept, ...rest];
  const shown = Math.min(
    keys.length,
    limit + LATE_ROOM,
    Math.max(limit, kept.length + Math.min(arrived, LATE_ROOM)),
  );
  const unchanged =
    shown === previous.shown &&
    keys.length === previous.keys.length &&
    keys.every((key, index) => key === previous.keys[index]);
  return unchanged ? previous : { query, keys, shown };
}

export interface SettledThreadSearch {
  readonly query: string;
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
}

/**
 * What a search box shows for `query`: its own results once they arrive
 * (`ready`), else the previous results if `query` refines or widens their
 * query, so result rows do not blink out and back on every keystroke.
 * Results for an unrelated query clear.
 */
export function visibleThreadSearch(
  query: string,
  ready: SettledThreadSearch | null,
  previous: SettledThreadSearch | null,
): SettledThreadSearch {
  if (ready !== null) return ready;
  const current = foldSearchQuery(query);
  const before = foldSearchQuery(previous?.query ?? "");
  return previous !== null &&
    current.length > 0 &&
    before.length > 0 &&
    (current.startsWith(before) || before.startsWith(current))
    ? previous
    : { query: "", matches: [] };
}
