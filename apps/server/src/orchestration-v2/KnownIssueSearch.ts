import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { truncateOnCodePoint } from "../textGeneration/TextGenerationUtils.ts";

/** The only repository known issues are looked up in and reports are filed against. */
export const T3_REPOSITORY = "pingdotgg/t3code";

const SEARCH_URL = "https://api.github.com/search/issues";
const SEARCH_TIMEOUT = Duration.seconds(3);
const MAX_CANDIDATES = 5;
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

/** One kind of failure, recognized by fixed phrases and named by a fixed term. */
interface FailureCategory {
  /** The only text of this category that ever leaves the machine. */
  readonly term: string;
  readonly patterns: ReadonlyArray<RegExp>;
}

/**
 * A phrase as the message must word it: the words separated only by
 * whitespace, and the whole phrase standing alone. Punctuation inside or
 * touching it (`auth.billing`, `billing-migration`) is part of a name, so it
 * can never complete a phrase.
 */
const phrase = (source: string): RegExp =>
  new RegExp(
    // A dot is punctuation only at the end of a sentence, so `a.phrase` and `phrase.b` are names.
    `(?<![\\w-])(?<!\\w\\.)(?:${source.replace(/ /g, "\\s+")})(?![\\w-])(?!\\.\\w)`,
    "i",
  );

/**
 * The kinds of failure a lookup can name, most specific first, drawn from the
 * failures T3 reports and the errors providers commonly return. A message
 * contributes which categories it matches and nothing of its own wording:
 * error text is arbitrary, and no filter makes arbitrary words safe for a
 * public search. Each term is fixed text written here.
 */
export const KNOWN_ISSUE_CATEGORIES: ReadonlyArray<FailureCategory> = [
  { term: "attachment read", patterns: [phrase("failed to read attachment")] },
  {
    term: "image processing",
    patterns: [phrase("an image in the conversation could not be processed")],
  },
  { term: "turn still active", patterns: [phrase("is still active")] },
  {
    term: "turn start",
    patterns: [
      phrase("(?:could not|failed to|did not) start (?:this |the |a |queued )?turn"),
      phrase("turn failed to start"),
      phrase("provider could not start"),
    ],
  },
  {
    term: "session open",
    patterns: [phrase("session (?:could not be opened|failed to open)")],
  },
  { term: "resume", patterns: [phrase("could not (?:be )?resume[d]?")] },
  {
    term: "event stream closed",
    patterns: [
      phrase("event stream (?:closed|was lost)"),
      phrase("session transport closed"),
      phrase("session closed before"),
    ],
  },
  { term: "rollback", patterns: [phrase("could not roll back")] },
  {
    term: "context handoff",
    patterns: [
      phrase("context allowance"),
      phrase("handoff"),
      phrase("conversation history reached"),
    ],
  },
  {
    term: "context window",
    patterns: [
      phrase("context (?:window|length)"),
      phrase("compaction"),
      phrase("prompt is too long"),
      phrase("maximum context"),
    ],
  },
  {
    term: "authentication",
    patterns: [
      phrase("unauthorized"),
      phrase("not authenticated"),
      phrase("authentication failed"),
      phrase("could not authenticate"),
      phrase("invalid api key"),
      phrase("invalid x-api-key"),
    ],
  },
  {
    term: "login required",
    patterns: [phrase("not logged in"), phrase("login required"), phrase("please log in")],
  },
  {
    term: "usage limit",
    patterns: [
      phrase("usage limit"),
      phrase("quota exceeded"),
      phrase("insufficient quota"),
      phrase("out of credits"),
    ],
  },
  {
    term: "rate limit",
    patterns: [phrase("rate limit(?:ed)?"), phrase("too many requests")],
  },
  {
    term: "permission denied",
    patterns: [
      phrase("permission denied"),
      phrase("eacces"),
      phrase("access denied"),
      phrase("forbidden"),
    ],
  },
  {
    term: "not installed",
    patterns: [
      phrase("command not found"),
      phrase("not installed"),
      phrase("enoent"),
      phrase("no such file or directory"),
      phrase("executable file not found"),
    ],
  },
  { term: "timeout", patterns: [phrase("timed out"), phrase("timeout")] },
  { term: "connection refused", patterns: [phrase("connection refused"), phrase("econnrefused")] },
  {
    term: "connection reset",
    patterns: [phrase("connection reset"), phrase("econnreset"), phrase("socket hang up")],
  },
  { term: "network error", patterns: [phrase("network (?:error|unreachable)")] },
  {
    term: "server unavailable",
    patterns: [phrase("overloaded"), phrase("service unavailable"), phrase("bad gateway")],
  },
  { term: "sandbox", patterns: [phrase("sandbox")] },
  { term: "mcp", patterns: [phrase("mcp")] },
  { term: "worktree", patterns: [phrase("worktree")] },
  { term: "checkpoint", patterns: [phrase("checkpoint")] },
  { term: "out of memory", patterns: [phrase("out of memory"), phrase("enomem")] },
  {
    term: "no space left",
    patterns: [phrase("no space left"), phrase("enospc"), phrase("disk full")],
  },
  { term: "background work", patterns: [phrase("still running background")] },
  {
    term: "model unavailable",
    patterns: [
      phrase("model (?:is )?(?:not found|not supported|unsupported|unavailable)"),
      phrase("unknown model"),
      phrase("unsupported model"),
    ],
  },
  {
    term: "structured output",
    patterns: [phrase("structured output"), phrase("invalid output")],
  },
  { term: "tool unavailable", patterns: [phrase("tool is no longer available")] },
  { term: "interrupted", patterns: [phrase("interrupted")] },
];

const MAX_QUERY_CATEGORIES = 3;

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
 * The fixed terms of the categories a failure matches, at most three, in the
 * categories' priority order. Which categories matched is all that is taken
 * from the message; none of its words are.
 */
export function categoryTermsForFailure(message: string): ReadonlyArray<string> {
  const text = withoutGuidance(message.slice(0, 4_096));
  return KNOWN_ISSUE_CATEGORIES.filter((category) =>
    category.patterns.some((pattern) => pattern.test(text)),
  )
    .slice(0, MAX_QUERY_CATEGORIES)
    .map((category) => category.term);
}

/**
 * The GitHub search query for a failure, or null when it matches no category.
 * It holds only category terms and the driver's keyword, every one fixed text
 * written in this module.
 */
export function buildKnownIssueQuery(input: {
  readonly message: string;
  readonly driver: string | null;
}): string | null {
  const terms = categoryTermsForFailure(input.message);
  if (terms.length === 0) return null;
  const driver = driverKeyword(input.driver);
  return `${[...terms, ...(driver === null ? [] : [driver])].join(" ")} repo:${T3_REPOSITORY} is:issue`;
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
  /** The searches under way, so identical lookups at once share one request. */
  const inFlight = new Map<string, Deferred.Deferred<ReadonlyArray<KnownIssueCandidate>>>();
  const none: ReadonlyArray<KnownIssueCandidate> = [];

  /**
   * One request. Every deadline is read from the clock when the answer arrives,
   * not when the request left, so a slow answer cannot shorten the wait it asks for.
   */
  const fetchCandidates = (query: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(SEARCH_URL).pipe(
          HttpClientRequest.setUrlParams({ q: query, per_page: String(MAX_CANDIDATES) }),
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "user-agent": "t3code",
            "x-github-api-version": "2022-11-28",
          }),
        ),
      );
      const receivedAt = yield* Clock.currentTimeMillis;
      const rateLimited =
        response.status === 403 ||
        response.status === 429 ||
        response.headers["x-ratelimit-remaining"] === "0";
      if (rateLimited) {
        const pause = pauseFromHeaders(response.headers, receivedAt);
        const alreadyPaused = receivedAt < pausedUntil;
        pausedUntil = Math.max(pausedUntil, receivedAt + pause);
        // An answer that used up the quota is still an answer; only the next search waits.
        if (!alreadyPaused) {
          yield* Effect.logWarning("Known issue search paused by GitHub's rate limit", {
            pauseMs: pause,
          });
        }
      }
      if (response.status < 200 || response.status >= 300) return none;
      const decoded = yield* response.json.pipe(Effect.flatMap(decodeSearchResponse));
      const candidates = decoded.items
        .slice(0, MAX_CANDIDATES)
        .map((item): KnownIssueCandidate => ({
          number: item.number,
          title: cleanTitle(item.title),
          state: item.state,
          url: knownIssueUrl(item.number),
        }));
      if (cache.size >= MAX_CACHED_QUERIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(query, { expiresAt: receivedAt + CACHE_TTL_MS, candidates });
      return candidates;
    }).pipe(
      Effect.timeout(SEARCH_TIMEOUT),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logDebug("Known issue search failed", cause).pipe(Effect.as(none)),
      ),
    );

  const search: KnownIssueSearch["Service"]["search"] = Effect.fn("KnownIssueSearch.search")(
    function* (input) {
      const query = buildKnownIssueQuery(input);
      if (query === null) return none;
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(query);
      if (cached !== undefined && cached.expiresAt > now) return cached.candidates;
      if (now < pausedUntil) return none;

      const mine = yield* Deferred.make<ReadonlyArray<KnownIssueCandidate>>();
      // Registering the search and installing its cleanup happen with interruption held off, so
      // an interrupt can never leave a registered search that nothing will settle. Only the
      // request and the wait for a shared search stay interruptible.
      return yield* Effect.uninterruptibleMask((restore) => {
        const sharing = inFlight.get(query);
        if (sharing !== undefined) return restore(Deferred.await(sharing));
        inFlight.set(query, mine);
        return restore(fetchCandidates(query)).pipe(
          // Cleared whether the search succeeded, failed, or was interrupted; those waiting on an
          // interrupted search get no candidates rather than an interruption of their own.
          Effect.onExit((exit) =>
            Effect.sync(() => inFlight.delete(query)).pipe(
              Effect.andThen(Deferred.succeed(mine, Exit.isSuccess(exit) ? exit.value : none)),
            ),
          ),
        );
      });
    },
  );

  return KnownIssueSearch.of({ search });
});

/** Searches through whichever `HttpClient` the caller supplies. */
export const layerWithHttpClient = Layer.effect(KnownIssueSearch, make);

export const layer = layerWithHttpClient.pipe(Layer.provide(FetchHttpClient.layer));
