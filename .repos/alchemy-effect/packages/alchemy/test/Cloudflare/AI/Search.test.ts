import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import AiSearchCrawlTargetWorker from "./fixtures/crawl-target-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Type-level coverage: the `AiSearch` construct result *is* an
// `AiSearchInstance`, so it can be passed anywhere one is expected. These
// assertions fail to compile the moment the construct stops being
// substitutable for an instance. The two binding styles are also exercised at
// runtime by the `bindings-stack` fixtures (Effect Worker `bind(...)` +
// async Worker `env`).
declare const _search: Cloudflare.AI.Search;
// 1. Assignable to an `AiSearchInstance` (and thus to
//    `Cloudflare.AI.Search.Search(...)`, which is how an Effect Worker attaches
//    the `ai_search` binding). These
//    assertions live inside a never-invoked closure so the type checks compile
//    without executing the `declare`d binding (which has no runtime value).
void (() => {
  const _asInstance: Cloudflare.AI.Search = _search;
  void _asInstance;
  void Cloudflare.AI.QuerySearch(_search);
});
// 2. As a Worker `env` binding, `InferEnv` resolves it to the same runtime
//    handle (`AiSearchInstance`) it would for a plain `AiSearchInstance`.
type _EnvSearch = Cloudflare.InferEnv<{
  SEARCH: Cloudflare.AI.Search;
}>["SEARCH"];
type _EnvInstance = Cloudflare.InferEnv<{
  SEARCH: Cloudflare.AI.Search;
}>["SEARCH"];
const _envSame: _EnvSearch extends _EnvInstance ? true : never = true;
void _envSame;

const getInstance = (accountId: string, id: string, namespace = "default") =>
  aisearch.readNamespaceInstance({ accountId, name: namespace, id }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, id: string, namespace = "default") =>
  getInstance(accountId, id, namespace).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "InstanceNotDeleted" } as const)),
    Effect.catchTag(
      ["AiSearchInstanceNotFound", "NamespaceNotFound"],
      () => Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "InstanceNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// The `AiSearch` construct composes an R2 bucket, a managed service token
// (AccountApiToken + AiSearchToken children), and the instance — a single
// `yield*` wires the whole pipeline together.
const program = () =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("AiSearchSource", {});
    const search = yield* Cloudflare.AI.Search("Search", {
      source: bucket,
    });
    return { bucket, search, serviceToken: search.serviceToken };
  });

test.provider(
  "construct auto-creates a managed token and wires it into the instance",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());

      const { search, serviceToken } = deployed;
      expect(search.instanceId).toBeTruthy();
      // The managed service token was minted as a child and wired in.
      expect(serviceToken).toBeDefined();
      expect(search.tokenId).toEqual(serviceToken!.id);

      // Cloudflare's read projection hides the token association
      // (`tokenId` comes back `null`), so verify the instance exists rather
      // than re-asserting the token id off the read path.
      const live = yield* getInstance(accountId, search.instanceId);
      expect(live.id).toEqual(search.instanceId);

      yield* stack.destroy();

      yield* expectGone(accountId, search.instanceId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// A web-crawler source crawls a seed URL and needs no service token, so the
// construct must NOT mint an AccountApiToken / AiSearchToken — `token` comes
// back undefined. Cloudflare only crawls a domain the account owns, so the
// crawl is seeded at a Worker we deploy (its `workers.dev` URL is owned by the
// account); `parseType: "crawl"` walks pages instead of requiring a sitemap.
const crawlerProgram = () =>
  Effect.gen(function* () {
    const target = yield* AiSearchCrawlTargetWorker;
    // Exercise the flattened source groups end-to-end: `parse` (parseType +
    // parse options) and `crawl` (link-discovery options) must translate into
    // the distilled `sourceParams.webCrawler.{parseType,parseOptions,crawlOptions}`.
    const search = yield* Cloudflare.AI.Search("Search", {
      source: target.url.as<string>(),
      parse: { type: "crawl", useBrowserRendering: false },
      // Discover URLs by following links only. Without `source: "links"`,
      // crawl link-discovery also reads the seed's sitemap, and a
      // freshly-deployed `workers.dev` URL serves none — Cloudflare rejects
      // the create with `missing_sitemap`.
      crawl: { depth: 2, includeSubdomains: false, source: "links" },
    });
    return { target, search, serviceToken: search.serviceToken };
  });

test.provider(
  "web-crawler source skips token minting",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Deploy the crawl target first and wait until its `workers.dev` URL is
      // actually serving. AI Search fetches the seed synchronously when it
      // validates a web-crawler at create time; against a URL that isn't live
      // yet it finds no content and rejects with `missing_sitemap`.
      const warmed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AiSearchCrawlTargetWorker;
        }),
      );
      const client = yield* HttpClient.HttpClient;
      const targetUrl = warmed.url;
      expect(targetUrl).toBeTypeOf("string");
      yield* client.get(targetUrl as string).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`crawl target not ready: ${res.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      );

      const deployed = yield* stack.deploy(crawlerProgram());

      const { search, serviceToken } = deployed;
      // No service token is minted for a web crawler.
      expect(serviceToken).toBeUndefined();
      expect(search.type).toEqual("web-crawler");

      const live = yield* getInstance(accountId, search.instanceId);
      expect(live.type).toEqual("web-crawler");

      yield* stack.destroy();

      yield* expectGone(accountId, search.instanceId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
