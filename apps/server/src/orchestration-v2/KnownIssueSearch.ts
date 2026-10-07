import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { truncateOnCodePoint } from "../textGeneration/TextGenerationUtils.ts";

/** The only repository known issues are looked up in and reports are filed against. */
export const T3_REPOSITORY = "pingdotgg/t3code";

const SEARCH_URL = "https://api.github.com/search/issues";
const SEARCH_TIMEOUT = Duration.seconds(3);
const MAX_CANDIDATES = 5;
const MAX_QUERY_WORDS = 6;
const MIN_QUERY_WORDS = 2;
const MAX_TITLE_CHARS = 120;
/** Unauthenticated search allows about ten requests a minute, so the pause is the safe default. */
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 15 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHED_QUERIES = 50;

/** An existing issue the failure might be. Only these fields ever reach the model. */
export interface KnownIssueCandidate {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

/**
 * The only words a public search is built from. Error text is arbitrary: it
 * carries hostnames, repository and branch names, and values after `key:`, and
 * no denylist catches every shape of those. So a word is sent only if it is
 * listed here, which keeps the query to generic diagnostic vocabulary drawn
 * from the failures T3 reports and the errors providers commonly return.
 */
export const KNOWN_ISSUE_VOCABULARY: ReadonlySet<string> = new Set(
  // What was being done.
  (
    "attachment attachments image file read write start started turn session open opened resume " +
    "resumed stream closed handoff history compact compaction context checkpoint worktree " +
    "background approval interrupted stopped cancelled aborted queued pending restart " +
    "restarted recovery recover reconnect disconnected delivery request response output " +
    "empty malformed decode schema command shell terminal workspace directory folder " +
    "database migration " +
    // Auth, limits, permissions.
    "auth authenticate authentication authenticated login logout unauthorized forbidden " +
    "expired invalid token rate limit limited quota exceeded usage billing permission " +
    "denied sandbox credentials " +
    // Process and environment.
    "spawn executable installed missing binary model unsupported outdated version protocol " +
    "mcp tool process pipe broken crashed exited killed memory disk space overflow " +
    "corrupted lock locked conflict " +
    // Network.
    "network connection refused reset timeout timed websocket unavailable overloaded server " +
    // State.
    "still active unexpectedly failed stuck hung length window budget"
  ).split(" "),
);

/**
 * The provider each driver kind is searched under. A fixed map, so a custom
 * or unknown driver contributes nothing rather than a name someone chose.
 */
const DRIVER_KEYWORDS: ReadonlyArray<readonly [prefix: string, keyword: string]> = [
  ["claude", "claude"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["opencode", "opencode"],
  ["grok", "grok"],
  ["antigravity", "antigravity"],
  ["acp", "acp"],
];

/** The canonical search keyword for a driver kind, or null for one not in the fixed map. */
export function driverKeyword(driver: string | null): string | null {
  const lower = driver?.toLowerCase() ?? "";
  if (lower === "pi") return "pi";
  return DRIVER_KEYWORDS.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
}

/**
 * T3's own guidance sentences. They say what to do, not what failed, and every
 * report would share them.
 */
const GUIDANCE_SENTENCE =
  /\b(?:retry the turn|if it keeps failing|check the (?:provider|server)|check that the provider|check the provider and server logs|check the provider setup|try again|restart)\b/i;

/** The message's sentences that describe the failure, without T3's guidance. */
export function withoutGuidance(message: string): string {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !GUIDANCE_SENTENCE.test(sentence))
    .join(" ");
}

/**
 * The vocabulary words in a failure, in order, at most six. Words are read as
 * runs of ASCII letters, so `API_KEY` yields `api` and `key` and a hostname or
 * branch name yields nothing unless it is itself a listed word.
 */
export function keywordsForFailure(message: string): ReadonlyArray<string> {
  const words: Array<string> = [];
  for (const match of withoutGuidance(message.slice(0, 4_096))
    .toLowerCase()
    .matchAll(/[a-z]+/g)) {
    const word = match[0];
    if (KNOWN_ISSUE_VOCABULARY.has(word) && !words.includes(word)) words.push(word);
  }
  return words.slice(0, MAX_QUERY_WORDS);
}

/**
 * The GitHub search query for a failure, or null when fewer than two
 * vocabulary words match. Every word in it is from `KNOWN_ISSUE_VOCABULARY`
 * or is the driver's keyword.
 */
export function buildKnownIssueQuery(input: {
  readonly message: string;
  readonly driver: string | null;
}): string | null {
  const words = [...keywordsForFailure(input.message)];
  if (words.length < MIN_QUERY_WORDS) return null;
  const driver = driverKeyword(input.driver);
  if (driver !== null && !words.includes(driver)) words.push(driver);
  return `${words.join(" ")} repo:${T3_REPOSITORY} is:issue`;
}

/**
 * The candidate a model named, only if it is one of the candidates. A number
 * the model made up, or one for a thread of issues it was not shown, is no match.
 */
export function selectKnownIssue(
  candidates: ReadonlyArray<KnownIssueCandidate>,
  number: number | null | undefined,
): KnownIssueCandidate | null {
  return number === null || number === undefined
    ? null
    : (candidates.find((candidate) => candidate.number === number) ?? null);
}

/** Issue titles are public text anyone can write, so they are flattened and bounded. */
function cleanTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_TITLE_CHARS
    ? flat
    : `${truncateOnCodePoint(flat, MAX_TITLE_CHARS - 3).trimEnd()}...`;
}

export const knownIssueUrl = (number: number) =>
  `https://github.com/${T3_REPOSITORY}/issues/${number}`;

const SearchResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      state: Schema.String,
    }),
  ),
});
const decodeSearchResponse = Schema.decodeUnknownEffect(SearchResponse);

/** How long GitHub asked searches to wait, from `retry-after` or the rate limit reset. */
function pauseFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number {
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1_000, MAX_PAUSE_MS);
  }
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  return headers["x-ratelimit-reset"] !== undefined && Number.isFinite(reset) && reset > now
    ? Math.min(reset - now, MAX_PAUSE_MS)
    : DEFAULT_PAUSE_MS;
}

export class KnownIssueSearch extends Context.Service<
  KnownIssueSearch,
  {
    /**
     * Existing issues that may describe the failure. Best effort: any failure
     * (network, rate limit, an unexpected answer) yields no candidates, because
     * an explanation never depends on this lookup.
     */
    readonly search: (input: {
      readonly message: string;
      readonly driver: string | null;
    }) => Effect.Effect<ReadonlyArray<KnownIssueCandidate>>;
  }
>()("t3/orchestration-v2/KnownIssueSearch") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  /** Searches are skipped until this time after GitHub refuses one for the rate limit. */
  let pausedUntil = 0;
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly candidates: ReadonlyArray<KnownIssueCandidate> }
  >();

  const search: KnownIssueSearch["Service"]["search"] = Effect.fn("KnownIssueSearch.search")(
    function* (input) {
      const query = buildKnownIssueQuery(input);
      if (query === null) return [];
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(query);
      if (cached !== undefined && cached.expiresAt > now) return cached.candidates;
      if (now < pausedUntil) return [];

      const none: ReadonlyArray<KnownIssueCandidate> = [];
      return yield* httpClient
        .execute(
          HttpClientRequest.get(SEARCH_URL).pipe(
            HttpClientRequest.setUrlParams({ q: query, per_page: String(MAX_CANDIDATES) }),
            HttpClientRequest.setHeaders({
              accept: "application/vnd.github+json",
              "user-agent": "t3code",
              "x-github-api-version": "2022-11-28",
            }),
          ),
        )
        .pipe(
          Effect.flatMap((response) => {
            const rateLimited =
              response.status === 403 ||
              response.status === 429 ||
              response.headers["x-ratelimit-remaining"] === "0";
            const pause = pauseFromHeaders(response.headers, now);
            // An answer that used up the quota is still an answer; only the next search waits.
            const pauseSearches = !rateLimited
              ? Effect.void
              : Effect.sync(() => {
                  const alreadyPaused = now < pausedUntil;
                  pausedUntil = Math.max(pausedUntil, now + pause);
                  return alreadyPaused;
                }).pipe(
                  Effect.flatMap((alreadyPaused) =>
                    alreadyPaused
                      ? Effect.void
                      : Effect.logWarning("Known issue search paused by GitHub's rate limit", {
                          pauseMs: pause,
                        }),
                  ),
                );
            if (response.status < 200 || response.status >= 300) {
              return pauseSearches.pipe(Effect.as(none));
            }
            return pauseSearches.pipe(
              Effect.andThen(response.json),
              Effect.flatMap(decodeSearchResponse),
              Effect.map((decoded) =>
                decoded.items.slice(0, MAX_CANDIDATES).map((item): KnownIssueCandidate => ({
                  number: item.number,
                  title: cleanTitle(item.title),
                  state: item.state,
                  url: knownIssueUrl(item.number),
                })),
              ),
              Effect.tap((candidates) =>
                Effect.sync(() => {
                  if (cache.size >= MAX_CACHED_QUERIES) {
                    const oldest = cache.keys().next();
                    if (!oldest.done) cache.delete(oldest.value);
                  }
                  cache.set(query, { expiresAt: now + CACHE_TTL_MS, candidates });
                }),
              ),
            );
          }),
          Effect.timeout(SEARCH_TIMEOUT),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logDebug("Known issue search failed", cause).pipe(Effect.as(none)),
          ),
        );
    },
  );

  return KnownIssueSearch.of({ search });
});

/** Searches through whichever `HttpClient` the caller supplies. */
export const layerWithHttpClient = Layer.effect(KnownIssueSearch, make);

export const layer = layerWithHttpClient.pipe(Layer.provide(FetchHttpClient.layer));
