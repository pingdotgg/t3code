import * as Effect from "effect/Effect";
import type { Input, InputProps } from "../../Input.ts";
import * as CoreNamespace from "../../Namespace.ts";
import { isResource } from "../../Resource.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Bucket } from "../R2/Bucket.ts";
import {
  SearchInstance,
  type SearchInstanceProps,
  type SourceParams,
} from "./SearchInstance.ts";
import type { SearchNamespace } from "./SearchNamespace.ts";
import { SearchToken } from "./SearchToken.ts";

type WebCrawlerParams = NonNullable<SourceParams["webCrawler"]>;

/**
 * How a web crawler discovers and parses pages — Cloudflare's `parseType`
 * folded together with its parse options. Defaults to `type: "sitemap"`.
 */
export type Parse = {
  /**
   * How pages are discovered:
   * - `"sitemap"` (default) — read `<seed>/sitemap.xml` (found via
   *   `robots.txt`) and index the URLs it lists.
   * - `"crawl"` — start at `source` and follow links.
   * - `"feed-rss"` — treat the seed as an RSS / Atom feed.
   * @default "sitemap"
   */
  type?: NonNullable<WebCrawlerParams["parseType"]>;
} & NonNullable<WebCrawlerParams["parseOptions"]>;

/**
 * Link-discovery options for a web crawler (mainly for `parse.type: "crawl"`):
 * `depth`, `includeSubdomains`, `includeExternalLinks`, `maxAge`, and `source`
 * (`"all"` | `"sitemaps"` | `"links"`).
 */
export type Crawl = NonNullable<WebCrawlerParams["crawlOptions"]>;

/**
 * Where crawled content is stored. Cloudflare provisions managed storage by
 * default; set this to store output in an R2 bucket you control.
 */
export type Store = {
  /** R2 bucket to store crawl output in. */
  bucket: Bucket;
  /** R2 data-residency jurisdiction for the store bucket. */
  jurisdiction?: string;
};

/**
 * Props common to every AI Search pipeline, regardless of data source. The
 * underlying instance's `type`, `source`, and `sourceParams` are derived from
 * the source-specific variant, so they're omitted here.
 */
export type SharedProps = Omit<
  InputProps<SearchInstanceProps, "type">,
  "type" | "source" | "sourceParams" | "namespace"
> & {
  /**
   * Namespace to group this pipeline under. Pass an {@link SearchNamespace}
   * resource — the engine orders this pipeline after the namespace on deploy
   * and tears it down before the namespace on destroy. Omit to place the
   * pipeline in the account-provided `default` namespace. The namespace is
   * immutable — changing it triggers a replacement.
   * @default the account-provided `default` namespace
   */
  namespace?: SearchNamespace;
};

/**
 * An R2-backed AI Search pipeline. Passing an {@link Bucket} as `source`
 * selects R2 as the data source.
 */
export type R2Props = SharedProps & {
  /**
   * The R2 bucket to index. AI Search needs a service token to read it; the
   * construct provisions one unless you pass your own `tokenId`.
   */
  source: Bucket;
  /** Only index object keys under this prefix. */
  prefix?: string;
  /**
   * Micromatch glob patterns; only objects matching at least one are
   * indexed (`*` within a path segment, `**` across segments). Max 10.
   */
  include?: string[];
  /**
   * Micromatch glob patterns; objects matching any are skipped. Exclude
   * takes precedence over `include`. Max 10.
   */
  exclude?: string[];
  /** R2 data-residency jurisdiction of the source bucket. */
  jurisdiction?: string;
  parse?: never;
  crawl?: never;
  store?: never;
};

/**
 * A web-crawler-backed AI Search pipeline. Passing a URL as `source` selects
 * the web crawler as the data source (no service token needed).
 */
export type WebCrawlerProps = SharedProps & {
  /** Seed URL to crawl and index. */
  source: Input<string>;
  /** How pages are discovered and parsed. */
  parse?: Parse;
  /** How links are followed from the seed. */
  crawl?: Crawl;
  /** Where crawl output is stored (defaults to managed storage). */
  store?: Store;
  prefix?: never;
  include?: never;
  exclude?: never;
  jurisdiction?: never;
};

/**
 * Props for the {@link Search} construct — a union discriminated by what you
 * pass as `source`: an {@link Bucket} for an R2 source, or a URL string for
 * a web crawl.
 */
export type Props = R2Props | WebCrawlerProps;

/**
 * The result of the {@link Search} construct. It *is* the underlying
 * {@link SearchInstance}, augmented with the managed `serviceToken`, so it
 * can be passed anywhere a `SearchInstance` is expected —
 * `Cloudflare.AI.QuerySearch(search)`, a Worker's `env`, etc.
 */
export type Search = SearchInstance & {
  /**
   * The managed AI Search service token minted for an R2 source, or
   * `undefined` when the source is a web crawler (no token needed) or you
   * supplied your own `tokenId`.
   */
  serviceToken: SearchToken | undefined;
};

/**
 * A convenience construct over {@link SearchInstance} that auto-creates the
 * sub-resources an AI Search instance typically needs, so a single call wires
 * up a working pipeline. The data source is chosen by what you pass as
 * `source` — an {@link Bucket} for R2, or a URL for a web crawl:
 *
 * - For an R2 source, it mints a least-privilege {@link AccountApiToken}
 *   (`AI Search Index Engine`, stable child `ApiToken`) and an
 *   {@link SearchToken} wrapping it (stable child `Token`), then passes
 *   that token to the instance.
 *   Cloudflare requires a service token to read an R2 bucket and only
 *   provisions one through the dashboard / Wrangler — never on a
 *   programmatic API create — so the construct provisions it for you. Pass
 *   your own `tokenId` to skip minting and reuse an existing token.
 * - It creates the {@link SearchInstance} (child `SearchInstance`) with the
 *   remaining props.
 *
 * Drop down to the low-level resources directly when you need to share a
 * token across instances, adopt an existing one, or bind a namespace.
 *
 * The returned value *is* an {@link SearchInstance} (augmented with the
 * managed `serviceToken`, `undefined` for a web crawler), so a `Search`
 * is usable anywhere a `SearchInstance` is expected — pass it straight to
 * `Cloudflare.AI.QuerySearch(search)` or a Worker's `env`.
 *
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating an AI Search pipeline
 * @example R2-backed instance (token provisioned for you)
 * Pass an {@link Bucket} as `source` — its presence selects R2.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("docs");
 * const search = yield* Cloudflare.AI.Search("docs-search", {
 *   source: bucket,
 * });
 * ```
 *
 * @example Index only part of a bucket
 * ```typescript
 * const search = yield* Cloudflare.AI.Search("docs-search", {
 *   source: bucket,
 *   prefix: "docs/",
 *   include: ["/docs/**"],
 *   exclude: ["/docs/drafts/**"],
 * });
 * ```
 *
 * @example Reuse an existing service token
 * ```typescript
 * const search = yield* Cloudflare.AI.Search("docs-search", {
 *   source: bucket,
 *   tokenId: existingToken.id,
 * });
 * ```
 *
 * @example Web-crawler source
 * Pass a URL as `source` to crawl and index a website (no service token
 * needed). `parse.type` defaults to `"sitemap"`; use `"crawl"` to follow
 * links from the seed instead.
 * ```typescript
 * const search = yield* Cloudflare.AI.Search("site-search", {
 *   source: "https://example.com",
 *   parse: { type: "crawl", contentSelector: [{ path: "/docs", selector: "main" }] },
 *   crawl: { depth: 3, includeSubdomains: true },
 * });
 * ```
 *
 * @example Store crawl output in your own bucket
 * ```typescript
 * const store = yield* Cloudflare.R2.Bucket("crawl-store");
 * const search = yield* Cloudflare.AI.Search("site-search", {
 *   source: "https://example.com",
 *   parse: { type: "crawl" },
 *   store: { bucket: store },
 * });
 * ```
 *
 * @section Binding to an Effect Worker
 *
 * The returned `search` is an {@link SearchInstance}. Bind it during the
 * Worker's init phase with `Cloudflare.AI.QuerySearch(search)`, which
 * attaches the single-instance `ai_search` binding and hands back an
 * Effect-native client whose `search` / `chatCompletions` methods return
 * `Effect`s. Provide `Cloudflare.AI.QuerySearchBinding` in the Worker's
 * runtime layer.
 *
 * @example Effect Worker that answers from AI Search
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const bucket = yield* Cloudflare.R2.Bucket("docs");
 *     const aiSearch = yield* Cloudflare.AI.Search("docs-search", {
 *       source: bucket,
 *     });
 *     const search = yield* Cloudflare.AI.QuerySearch(aiSearch);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const query = new URL(request.url).searchParams.get("q") ?? "";
 *         const answer = yield* search.chatCompletions({
 *           messages: [{ role: "user", content: query }],
 *         });
 *         return yield* HttpServerResponse.json(answer);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AI.QuerySearchBinding)),
 * ) {}
 * ```
 *
 * @section Binding to an Async Worker
 *
 * For a vanilla `async fetch` Worker, pass the `search` under `Worker.env`.
 * The engine attaches the same single-instance `ai_search` binding (see
 * `toBinding` in `WorkerAsyncBindings.ts`), orders the deploy
 * bucket → instance → worker, and `InferEnv` types `env.SEARCH` as the
 * runtime `SearchInstance` handle — no hand-written types.
 *
 * @example Async Worker that answers from AI Search
 * ```typescript
 * // stack.ts
 * const bucket = yield* Cloudflare.R2.Bucket("docs");
 * const search = yield* Cloudflare.AI.Search("docs-search", {
 *   source: bucket,
 * });
 *
 * export const Api = Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: search },
 * });
 * export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
 *
 * // worker.ts
 * import type { ApiEnv } from "./stack.ts";
 * export default {
 *   async fetch(request: Request, env: ApiEnv): Promise<Response> {
 *     const query = new URL(request.url).searchParams.get("q") ?? "";
 *     const answer = await env.SEARCH.chatCompletions({
 *       messages: [{ role: "user", content: query }],
 *     });
 *     return Response.json(answer);
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const Search = (id: string, props: Props) =>
  Effect.gen(function* () {
    const {
      source,
      prefix,
      include,
      exclude,
      jurisdiction,
      parse,
      crawl,
      store,
      namespace,
      ...shared
    } = props;

    let tokenId = shared.tokenId;
    let serviceToken: SearchToken | undefined;
    let type: "r2" | "web-crawler";
    let instanceSource: Input<string>;
    let sourceParams: Input<SourceParams> | undefined;

    // Discriminate the data source on what `source` is: an Bucket (a resource)
    // indexes a bucket and needs a service token to read it; a URL crawls a seed
    // and doesn't.
    if (isResource(source)) {
      const bucket = source as Bucket;
      type = "r2";
      instanceSource = bucket.bucketName;
      sourceParams = clean({
        prefix,
        includeItems: include,
        excludeItems: exclude,
        r2Jurisdiction: jurisdiction,
      }) as Input<SourceParams> | undefined;

      // Cloudflare requires a service token to read an R2 source and only
      // auto-creates one via the dashboard/Wrangler — not on a programmatic
      // API create. Mint one ourselves unless the caller passed a `tokenId`.
      if (tokenId === undefined) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const apiToken = yield* AccountApiToken("ApiToken", {
          policies: [
            {
              effect: "allow",
              permissionGroups: ["AI Search Index Engine"],
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });
        serviceToken = yield* SearchToken("Token", {
          cfApiId: apiToken.tokenId,
          cfApiKey: apiToken.value,
        });
        tokenId = serviceToken.id;
      }
    } else {
      type = "web-crawler";
      instanceSource = source as Input<string>;

      const { type: parseType, ...parseOptions } = parse ?? {};
      const webCrawler = clean({
        parseType,
        parseOptions: clean(parseOptions),
        crawlOptions: crawl ? clean(crawl) : undefined,
        storeOptions: store
          ? clean({
              storageId: store.bucket.bucketName,
              storageType: "r2" as const,
              r2Jurisdiction: store.jurisdiction,
            })
          : undefined,
      });
      sourceParams = webCrawler
        ? ({ webCrawler } as Input<SourceParams>)
        : undefined;
    }

    const instance = yield* SearchInstance("Instance", {
      ...shared,
      // The instance is keyed by namespace name; pass the namespace's `name`
      // output so the engine orders instance-after-namespace.
      namespace: namespace?.name,
      type,
      source: instanceSource,
      tokenId,
      sourceParams,
    });

    // Return the instance itself (augmented with the managed `serviceToken`)
    // so a `Search` is usable anywhere a `SearchInstance` is expected —
    // `Cloudflare.AI.QuerySearch(search)`, `env: { SEARCH: search }`, etc.
    return Object.assign(instance, { serviceToken }) as Search;
  }).pipe(CoreNamespace.push(id));

/** Drop `undefined` entries; return `undefined` when nothing is left. */
const clean = <T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: T[K] } | undefined => {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length
    ? (Object.fromEntries(entries) as { [K in keyof T]: T[K] })
    : undefined;
};
