/**
 * WebTools - the web search and page fetch behind the `web_search` and
 * `web_fetch` MCP tools. Every call reads the environment's web settings, so a
 * provider or key saved in Settings → Tools → Web applies without a restart.
 *
 * @module WebTools
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type WebSettings,
  type WebToolProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";

export const MAX_WEB_SEARCH_RESULTS = 10;
const DEFAULT_WEB_SEARCH_RESULTS = 5;
/** Page text past this is cut so one long page cannot crowd out the agent's context. */
export const MAX_WEB_FETCH_CHARS = 40_000;
const MAX_SNIPPET_CHARS = 500;
const FIRECRAWL_INTEGRATION = "_t3code";
const WEB_SEARCH_TIMEOUT = Duration.seconds(30);
// A scrape renders the page, which takes longer than a search.
const WEB_FETCH_TIMEOUT = Duration.seconds(60);

type ApiProvider = Exclude<WebToolProvider, "builtin">;
type WebToolOperation = "search" | "fetch";

const PROVIDER_LABELS: Record<ApiProvider, string> = {
  firecrawl: "Firecrawl",
  exa: "Exa",
  tavily: "Tavily",
};

// Agents keep their own web tools, so a failed call tells them to use those.
const FALL_BACK = "Use your own web tools for this request.";

class WebToolsDisabledError extends Schema.TaggedError<WebToolsDisabledError>()(
  "WebToolsDisabledError",
  {},
) {
  override get message(): string {
    return "T3 Code web tools are off for this environment. Use your own web tools, or pick a web provider in Settings → Tools → Web.";
  }
}

class WebToolsApiKeyMissingError extends Schema.TaggedError<WebToolsApiKeyMissingError>()(
  "WebToolsApiKeyMissingError",
  { provider: Schema.Literals(["exa", "tavily"]) },
) {
  override get message(): string {
    return `Add your ${PROVIDER_LABELS[this.provider]} API key in Settings → Tools → Web.`;
  }
}

class WebToolsRequestError extends Schema.TaggedError<WebToolsRequestError>()(
  "WebToolsRequestError",
  {
    provider: Schema.Literals(["firecrawl", "exa", "tavily"]),
    operation: Schema.Literals(["search", "fetch"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not reach ${PROVIDER_LABELS[this.provider]} for web ${this.operation}. ${FALL_BACK}`;
  }
}

class WebToolsResponseError extends Schema.TaggedError<WebToolsResponseError>()(
  "WebToolsResponseError",
  {
    provider: Schema.Literals(["firecrawl", "exa", "tavily"]),
    operation: Schema.Literals(["search", "fetch"]),
    status: Schema.Number,
    /** Sent without an API key, on Firecrawl's keyless tier. */
    keyless: Schema.Boolean,
  },
) {
  override get message(): string {
    const label = PROVIDER_LABELS[this.provider];
    const hint =
      this.keyless && (this.status === 401 || this.status === 403)
        ? ` ${label}'s keyless tier refused this network, as it does on datacenter, VPN and CI networks; an API key in Settings → Tools → Web avoids that.`
        : this.status === 401 || this.status === 403
          ? " Check the API key in Settings → Tools → Web."
          : this.status === 402 || this.status === 429
            ? " The account is out of credits or rate limited."
            : "";
    return `${label} web ${this.operation} failed with HTTP ${this.status}.${hint} ${FALL_BACK}`;
  }
}

class WebToolsTimeoutError extends Schema.TaggedError<WebToolsTimeoutError>()(
  "WebToolsTimeoutError",
  {
    provider: Schema.Literals(["firecrawl", "exa", "tavily"]),
    operation: Schema.Literals(["search", "fetch"]),
  },
) {
  override get message(): string {
    return `${PROVIDER_LABELS[this.provider]} web ${this.operation} did not answer in time. ${FALL_BACK}`;
  }
}

class WebToolsResponseDecodeError extends Schema.TaggedError<WebToolsResponseDecodeError>()(
  "WebToolsResponseDecodeError",
  {
    provider: Schema.Literals(["firecrawl", "exa", "tavily"]),
    operation: Schema.Literals(["search", "fetch"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${PROVIDER_LABELS[this.provider]} returned an unexpected web ${this.operation} response.`;
  }
}

class WebFetchEmptyError extends Schema.TaggedError<WebFetchEmptyError>()("WebFetchEmptyError", {
  provider: Schema.Literals(["firecrawl", "exa", "tavily"]),
}) {
  override get message(): string {
    return `${PROVIDER_LABELS[this.provider]} returned no content for this page.`;
  }
}

export type WebToolsError =
  | WebToolsDisabledError
  | WebToolsApiKeyMissingError
  | WebToolsRequestError
  | WebToolsResponseError
  | WebToolsTimeoutError
  | WebToolsResponseDecodeError
  | WebFetchEmptyError;

interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

interface WebSearchResult {
  readonly provider: ApiProvider;
  readonly results: ReadonlyArray<WebSearchHit>;
}

interface WebFetchResult {
  readonly provider: ApiProvider;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
}

export class WebTools extends Context.Service<
  WebTools,
  {
    readonly search: (input: {
      readonly query: string;
      readonly limit?: number | undefined;
    }) => Effect.Effect<WebSearchResult, WebToolsError>;
    readonly fetch: (input: {
      readonly url: string;
    }) => Effect.Effect<WebFetchResult, WebToolsError>;
  }
>()("t3/web/WebTools") {}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const FirecrawlSearchResponse = Schema.Struct({
  data: Schema.Struct({
    web: Schema.optional(
      Schema.Array(
        Schema.Struct({ url: Schema.String, title: OptionalString, description: OptionalString }),
      ),
    ),
  }),
});

const FirecrawlScrapeResponse = Schema.Struct({
  data: Schema.Struct({
    markdown: OptionalString,
    metadata: Schema.optional(
      Schema.Struct({ title: OptionalString, url: OptionalString, sourceURL: OptionalString }),
    ),
  }),
});

const ExaResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ url: Schema.String, title: OptionalString, text: OptionalString }),
  ),
});

const TavilySearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ url: Schema.String, title: OptionalString, content: OptionalString }),
  ),
});

const TavilyExtractResponse = Schema.Struct({
  results: Schema.Array(Schema.Struct({ url: Schema.String, raw_content: OptionalString })),
});

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const hit = (
  url: string,
  title: string | null | undefined,
  snippet: string | null | undefined,
) => ({
  url,
  title: title?.trim() ?? "",
  snippet: cut(snippet?.trim() ?? "", MAX_SNIPPET_CHARS),
});

const page = (
  provider: ApiProvider,
  url: string,
  title: string | null | undefined,
  content: string | null | undefined,
): Effect.Effect<WebFetchResult, WebFetchEmptyError> => {
  const text = content?.trim() ?? "";
  if (text.length === 0) return Effect.fail(new WebFetchEmptyError({ provider }));
  return Effect.succeed({
    provider,
    url,
    title: title?.trim() ?? "",
    content: text.slice(0, MAX_WEB_FETCH_CHARS),
    truncated: text.length > MAX_WEB_FETCH_CHARS,
  });
};

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const postJson = <S extends Schema.Top>(
    provider: ApiProvider,
    operation: WebToolOperation,
    url: string,
    headers: Record<string, string>,
    body: unknown,
    schema: S,
  ): Effect.Effect<S["Type"], WebToolsError, S["DecodingServices"]> =>
    // A provider that hangs must not stall the agent's turn.
    timeoutWith(
      provider,
      operation,
    )(
      httpClient
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          Effect.mapError((cause) => new WebToolsRequestError({ provider, operation, cause })),
          Effect.flatMap(
            HttpClientResponse.matchStatus({
              "2xx": (success) =>
                HttpClientResponse.schemaBodyJson(schema)(success).pipe(
                  Effect.mapError(
                    (cause) => new WebToolsResponseDecodeError({ provider, operation, cause }),
                  ),
                ),
              orElse: (failed) =>
                Effect.fail(
                  new WebToolsResponseError({
                    provider,
                    operation,
                    status: failed.status,
                    keyless: !("authorization" in headers) && !("x-api-key" in headers),
                  }),
                ),
            }),
          ),
        ),
    );

  const timeoutWith =
    (provider: ApiProvider, operation: WebToolOperation) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: operation === "search" ? WEB_SEARCH_TIMEOUT : WEB_FETCH_TIMEOUT,
          orElse: () => Effect.fail(new WebToolsTimeoutError({ provider, operation })),
        }),
      );

  // Firecrawl works without a key on eligible networks, so it never needs one here.
  // Its `integration` field is a closed list; an `_` prefix marks an unlisted caller.
  const firecrawlHeaders = (key: string): Record<string, string> =>
    key.length > 0 ? { authorization: `Bearer ${key}` } : {};

  const requireKey = (
    provider: "exa" | "tavily",
    key: string,
  ): Effect.Effect<string, WebToolsApiKeyMissingError> =>
    key.length > 0
      ? Effect.succeed(key)
      : Effect.fail(new WebToolsApiKeyMissingError({ provider }));

  const searchWith = (
    settings: WebSettings,
    provider: ApiProvider,
    query: string,
    limit: number,
  ) => {
    switch (provider) {
      case "firecrawl":
        return postJson(
          provider,
          "search",
          "https://api.firecrawl.dev/v2/search",
          firecrawlHeaders(settings.firecrawlApiKey),
          { query, limit, integration: FIRECRAWL_INTEGRATION },
          FirecrawlSearchResponse,
        ).pipe(
          Effect.map((response) =>
            (response.data.web ?? []).map((item) => hit(item.url, item.title, item.description)),
          ),
        );
      case "exa":
        return requireKey(provider, settings.exaApiKey).pipe(
          Effect.flatMap((key) =>
            postJson(
              provider,
              "search",
              "https://api.exa.ai/search",
              { "x-api-key": key },
              {
                query,
                numResults: limit,
                contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
              },
              ExaResponse,
            ),
          ),
          Effect.map((response) =>
            response.results.map((item) => hit(item.url, item.title, item.text)),
          ),
        );
      case "tavily":
        return requireKey(provider, settings.tavilyApiKey).pipe(
          Effect.flatMap((key) =>
            postJson(
              provider,
              "search",
              "https://api.tavily.com/search",
              { authorization: `Bearer ${key}` },
              { query, max_results: limit },
              TavilySearchResponse,
            ),
          ),
          Effect.map((response) =>
            response.results.map((item) => hit(item.url, item.title, item.content)),
          ),
        );
    }
  };

  const fetchWith = (settings: WebSettings, provider: ApiProvider, url: string) => {
    switch (provider) {
      case "firecrawl":
        return postJson(
          provider,
          "fetch",
          "https://api.firecrawl.dev/v2/scrape",
          firecrawlHeaders(settings.firecrawlApiKey),
          // Firecrawl serves cached pages up to two days old by default; agents
          // fetch to read the page as it is now (a package's latest version, docs).
          {
            url,
            formats: ["markdown"],
            onlyMainContent: true,
            maxAge: 0,
            integration: FIRECRAWL_INTEGRATION,
          },
          FirecrawlScrapeResponse,
        ).pipe(
          Effect.flatMap(({ data }) =>
            page(
              provider,
              data.metadata?.url ?? data.metadata?.sourceURL ?? url,
              data.metadata?.title,
              data.markdown,
            ),
          ),
        );
      case "exa":
        return requireKey(provider, settings.exaApiKey).pipe(
          Effect.flatMap((key) =>
            postJson(
              provider,
              "fetch",
              "https://api.exa.ai/contents",
              { "x-api-key": key },
              { urls: [url], text: true },
              ExaResponse,
            ),
          ),
          Effect.flatMap(({ results }) =>
            page(provider, results[0]?.url ?? url, results[0]?.title, results[0]?.text),
          ),
        );
      case "tavily":
        return requireKey(provider, settings.tavilyApiKey).pipe(
          Effect.flatMap((key) =>
            postJson(
              provider,
              "fetch",
              "https://api.tavily.com/extract",
              { authorization: `Bearer ${key}` },
              { urls: [url], format: "markdown" },
              TavilyExtractResponse,
            ),
          ),
          Effect.flatMap(({ results }) =>
            page(provider, results[0]?.url ?? url, undefined, results[0]?.raw_content),
          ),
        );
    }
  };

  const currentProvider = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.web),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited key.
      Effect.logWarning("failed to read web settings", { operation: error.operation }).pipe(
        Effect.as(DEFAULT_SERVER_SETTINGS.web),
      ),
    ),
    Effect.flatMap((settings) =>
      settings.provider === "builtin"
        ? Effect.fail(new WebToolsDisabledError())
        : Effect.succeed({ settings, provider: settings.provider }),
    ),
  );

  const search: WebTools["Service"]["search"] = Effect.fn("WebTools.search")(function* (input) {
    const { settings, provider } = yield* currentProvider;
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_WEB_SEARCH_RESULTS, 1),
      MAX_WEB_SEARCH_RESULTS,
    );
    const results = yield* searchWith(settings, provider, input.query, limit);
    return { provider, results: results.slice(0, limit) };
  });

  const fetch: WebTools["Service"]["fetch"] = Effect.fn("WebTools.fetch")(function* (input) {
    const { settings, provider } = yield* currentProvider;
    return yield* fetchWith(settings, provider, input.url);
  });

  return WebTools.of({ search, fetch });
});

export const layer = Layer.effect(WebTools, make);
