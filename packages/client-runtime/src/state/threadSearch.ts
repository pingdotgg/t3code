import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  ProjectId,
  type OrchestrationThreadSearchMatch,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ThreadFamily,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  foldSearchQuery,
  messageSearchTokens,
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
let localThreadOpensVersion = 0;
/**
 * Records that this client opened a thread, and says whether to send the open
 * to the server now.
 */
export function claimThreadOpen(environmentId: EnvironmentId, threadId: string, now: number) {
  const key = `${environmentId}:${threadId}`;
  localThreadOpens.set(key, now);
  localThreadOpensVersion += 1;
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
  /** Rows of matching older settled threads, which shells that omit them do not hold. */
  readonly rows: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly read: OrchestrationV2ThreadFamily;
  }>;
}

/**
 * How a search reaches environments whose shells omit older settled threads (others ignore it):
 * the caller's project scope and its names for environments, which its own ranking matches, and
 * whether to skip message search.
 */
export const ThreadSearchScope = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  environmentLabels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  titlesOnly: Schema.optionalKey(Schema.Boolean),
});
export type ThreadSearchScope = typeof ThreadSearchScope.Type;

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Union([
    Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
    Schema.Tuple([
      Schema.Array(EnvironmentId),
      OrchestrationSearchThreadsInput.fields.query,
      ThreadSearchScope,
    ]),
  ]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);
const EMPTY_SEARCH_ROWS: ThreadSearchResultsState["rows"] = [];
const EMPTY_READS: ReadonlyArray<OrchestrationV2ThreadFamily> = [];

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  scope: ThreadSearchScope = {},
): string {
  const sorted = [...environmentIds].sort((left, right) => left.localeCompare(right));
  return JSON.stringify(Object.keys(scope).length === 0 ? [sorted, query] : [sorted, query, scope]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Message matches from every environment, plus, from environments whose shells omit older settled
 * threads (`olderSettledBefore` is set), the rows of the best older matches. Callers mount those
 * rows (`rows`) so their own ranking sees them, as it sees shell rows.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    input: OrchestrationV2SearchThreadsInput,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2SearchThreadsResult, E>>;
  readonly olderSettledBefore?: (environmentId: EnvironmentId) => Atom.Atom<string | null>;
  readonly labelPrefix: string;
}) {
  const results = Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false, rows: EMPTY_SEARCH_ROWS };
      }

      const [environmentIds, query, scope = {}] = parsedKey.value;
      // The server needs a word of three or more letters to match messages.
      const searchMessages =
        scope.titlesOnly !== true && messageSearchTokens(query).long.length > 0;
      const matches: EnvironmentThreadSearchMatch[] = [];
      const rows: Array<ThreadSearchResultsState["rows"][number]> = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const before = options.olderSettledBefore
          ? get(options.olderSettledBefore(environmentId))
          : null;
        if (!searchMessages && before === null) continue;
        const label = scope.environmentLabels?.[environmentId];
        const result = get(
          options.getSearchAtom(environmentId, {
            query,
            ...(before === null
              ? {}
              : {
                  olderSettledBefore: before,
                  ...(scope.projectIds === undefined ? {} : { projectIds: scope.projectIds }),
                  ...(label === undefined ? {} : { environmentLabel: label }),
                  ...(searchMessages ? {} : { titlesOnly: true }),
                }),
          }),
        );
        isLoading ||= result.waiting;
        const value = AsyncResult.getOrElse(result, () => null);
        if (value !== null) {
          matches.push(...value.matches.map((match) => ({ ...match, environmentId })));
          if (value.threads !== undefined && value.threads.length > 0) {
            rows.push({
              environmentId,
              read: { snapshotSequence: value.snapshotSequence ?? 0, threads: value.threads },
            });
          }
        }
      }

      return { matches, isLoading, rows: rows.length === 0 ? EMPTY_SEARCH_ROWS : rows };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
  const rowsAtom = Atom.family((rowsKey: string) => {
    const [key, environmentId] = JSON.parse(rowsKey) as [string, EnvironmentId];
    let previous = EMPTY_READS;
    return Atom.make((get) => {
      const next = get(results(key)).rows.flatMap((row) =>
        row.environmentId === environmentId ? [row.read] : [],
      );
      if (next.length === previous.length && next.every((read, index) => read === previous[index]))
        return previous;
      previous = next.length === 0 ? EMPTY_READS : next;
      return previous;
    }).pipe(Atom.withLabel(`${options.labelPrefix}-rows:${rowsKey}`));
  });
  return {
    results,
    /** One environment's older settled rows for a search key, for `mountRows`. */
    rows: (key: string, environmentId: EnvironmentId) =>
      rowsAtom(JSON.stringify([key, environmentId])),
  };
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
  // A keystroke ranks the same shells again, so a subject is built once per shell.
  const cached = subjectCache.get(thread);
  if (
    cached !== undefined &&
    cached.projectTitle === projectTitle &&
    cached.environmentLabel === environmentLabel &&
    cached.opensVersion === localThreadOpensVersion
  ) {
    return cached.subject;
  }
  const subject = buildThreadSearchSubject(thread, projectTitle, environmentLabel);
  subjectCache.set(thread, {
    projectTitle,
    environmentLabel,
    opensVersion: localThreadOpensVersion,
    subject,
  });
  return subject;
}

const subjectCache = new WeakMap<
  ThreadSearchShell,
  {
    readonly projectTitle: string | null | undefined;
    readonly environmentLabel: string | null | undefined;
    readonly opensVersion: number;
    readonly subject: ThreadSearchSubject;
  }
>();

function buildThreadSearchSubject(
  thread: ThreadSearchShell,
  projectTitle: string | null | undefined,
  environmentLabel: string | null | undefined,
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
 * Keep shown rows in place so late results cannot move the pointer or keyboard target.
 * Allow up to LATE_ROOM extra rows so late best matches remain visible.
 * Reuse `previous` when unchanged to avoid a React state update.
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
