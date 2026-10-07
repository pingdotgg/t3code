import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** The only repository known issues are looked up in and reports are filed against. */
export const T3_REPOSITORY = "pingdotgg/t3code";

const SEARCH_URL = "https://api.github.com/search/issues";
const SEARCH_TIMEOUT = Duration.seconds(5);
const MAX_CANDIDATES = 5;
const MAX_QUERY_WORDS = 6;
const MAX_TITLE_CHARS = 120;
const MAX_WORD_CHARS = 20;
const MIN_WORD_CHARS = 3;

/** An existing issue the failure might be. Only these fields ever reach the model. */
export interface KnownIssueCandidate {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

const STOP_WORDS = new Set(
  (
    "the and for with that this was were has have had not but are its into from onto over " +
    "than then when while which who whom what will would could should can may might must " +
    "does did done been being them they their there here out off all any some each only " +
    "also just too very more most such per via your you our use used using"
  ).split(" "),
);

/** Words that introduce a value a message must not leak into a public search. */
const SECRET_LEAD_WORDS = new Set([
  "bearer",
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "authorization",
  "credential",
  "credentials",
  "cookie",
]);

/**
 * T3's own guidance sentences. They say what to do, not what failed, and every
 * report would share them.
 */
const GUIDANCE_SENTENCE =
  /\b(?:retry the turn|if it keeps failing|check the (?:provider|server)|check that the provider|check the provider and server logs|check the provider setup|try again|restart)\b/i;

const WORD = /^[A-Za-z][A-Za-z-]*[A-Za-z]$/;

/** The message's sentences that describe the failure, without T3's guidance. */
export function withoutGuidance(message: string): string {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !GUIDANCE_SENTENCE.test(sentence))
    .join(" ");
}

/**
 * The few distinctive words of a failure, safe to send to a public search. A
 * word survives only if it is plain letters: anything with a digit, slash,
 * colon, `@`, `=`, or underscore is an id, path, URL, or setting, and quoted
 * text is dropped whole. Long words and the word after "token" or "key" are
 * dropped too, since either can be a secret.
 */
export function keywordsForFailure(message: string): ReadonlyArray<string> {
  const withoutQuotes = message
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " ");
  const words: Array<string> = [];
  let previous = "";
  for (const raw of withoutGuidance(withoutQuotes).split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    const lower = token.toLowerCase();
    const afterSecretLead = SECRET_LEAD_WORDS.has(previous);
    previous = lower;
    if (
      !WORD.test(token) ||
      token.length < MIN_WORD_CHARS ||
      token.length > MAX_WORD_CHARS ||
      STOP_WORDS.has(lower) ||
      afterSecretLead ||
      SECRET_LEAD_WORDS.has(lower) ||
      // The edges were punctuation around a path, home directory, or `key=value`.
      /[\d/\\@=_]/.test(raw) ||
      raw.startsWith("~")
    ) {
      continue;
    }
    if (!words.includes(lower)) words.push(lower);
  }
  return words.slice(0, MAX_QUERY_WORDS);
}

/** A search-friendly name for a driver kind, such as `claude` for `claudeAgent`. */
function driverKeyword(driver: string | null): string | null {
  const name = driver?.replace(/Agent$/, "").toLowerCase() ?? "";
  return /^[a-z][a-z-]{1,19}$/.test(name) ? name : null;
}

/**
 * The GitHub search query for a failure, or null when nothing distinctive
 * survives. The query is public: it holds only the words from `keywordsForFailure`
 * and the driver's name, never an id, path, URL, or secret.
 */
export function buildKnownIssueQuery(input: {
  readonly message: string;
  readonly driver: string | null;
}): string | null {
  const words = [...keywordsForFailure(input.message)];
  if (words.length < 2) return null;
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
    : `${flat.slice(0, MAX_TITLE_CHARS - 3).trimEnd()}...`;
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

  const search: KnownIssueSearch["Service"]["search"] = Effect.fn("KnownIssueSearch.search")(
    function* (input) {
      const query = buildKnownIssueQuery(input);
      if (query === null) return [];
      const candidates = yield* httpClient
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
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeSearchResponse),
          Effect.timeout(SEARCH_TIMEOUT),
          Effect.map((response) =>
            response.items.slice(0, MAX_CANDIDATES).map((item): KnownIssueCandidate => ({
              number: item.number,
              title: cleanTitle(item.title),
              state: item.state,
              url: knownIssueUrl(item.number),
            })),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logDebug("Known issue search failed", cause).pipe(
                  Effect.as([] as ReadonlyArray<KnownIssueCandidate>),
                ),
          ),
        );
      return candidates;
    },
  );

  return KnownIssueSearch.of({ search });
});

/** Searches through whichever `HttpClient` the caller supplies. */
export const layerWithHttpClient = Layer.effect(KnownIssueSearch, make);

export const layer = layerWithHttpClient.pipe(Layer.provide(FetchHttpClient.layer));
