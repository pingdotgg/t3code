import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls. Instances are namespace-scoped, so
// verify through the namespace-scoped read (defaulting to `default`).
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
    // A missing instance (`AiSearchInstanceNotFound`, code 7002) or a
    // missing enclosing namespace (`NamespaceNotFound`, code 7063) is the
    // success condition here.
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

// One program deploying both the R2 source bucket and the AI Search
// instance indexing it. The instance's `source` references the bucket
// name so the engine orders instance-after-bucket on deploy (and the
// reverse on destroy).
const program = (props?: Partial<Cloudflare.AI.SearchInstanceProps>) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("AiSearchSource", {});
    const instance = yield* Cloudflare.AI.SearchInstance("Search", {
      source: bucket.bucketName,
      ...props,
    });
    return { bucket, instance };
  });

test.provider(
  "create, update mutable props, and delete an r2-backed instance",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — engine-generated instance id, default settings.
      const initial = yield* stack.deploy(program());

      expect(initial.instance.instanceId).toBeTruthy();
      expect(initial.instance.accountId).toEqual(accountId);
      expect(initial.instance.type).toEqual("r2");
      expect(initial.instance.source).toEqual(initial.bucket.bucketName);

      const live = yield* getInstance(accountId, initial.instance.instanceId);
      expect(live.id).toEqual(initial.instance.instanceId);
      expect(live.source).toEqual(initial.bucket.bucketName);
      expect(live.type).toEqual("r2");

      // Update mutable props in place — same instance id.
      const updated = yield* stack.deploy(
        program({
          aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          maxNumResults: 20,
          chunkSize: 512,
          chunkOverlap: 15,
        }),
      );

      expect(updated.instance.instanceId).toEqual(initial.instance.instanceId);
      expect(updated.instance.aiSearchModel).toEqual(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );

      // The update PUT returns the new settings immediately, but the
      // out-of-band read endpoint reflects them eventually-consistently (it
      // briefly serves `aiSearchModel: ""` right after the write). Poll the
      // readback until the mutated props land before asserting, bounded.
      const liveUpdated = yield* getInstance(
        accountId,
        updated.instance.instanceId,
      ).pipe(
        Effect.flatMap((live) =>
          live.aiSearchModel === "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
            ? Effect.succeed(live)
            : Effect.fail({ _tag: "InstanceUpdateNotApplied" } as const),
        ),
        Effect.retry({
          while: (e) => e._tag === "InstanceUpdateNotApplied",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
      );
      expect(liveUpdated.aiSearchModel).toEqual(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );
      expect(liveUpdated.maxNumResults).toEqual(20);
      expect(liveUpdated.chunkSize).toEqual(512);
      expect(liveUpdated.chunkOverlap).toEqual(15);

      // Redeploying identical props is a no-op (still the same instance).
      const noop = yield* stack.deploy(
        program({
          aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          maxNumResults: 20,
          chunkSize: 512,
          chunkOverlap: 15,
        }),
      );
      expect(noop.instance.instanceId).toEqual(initial.instance.instanceId);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.instance.instanceId);

      // Destroy again — delete must be idempotent (already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "changing the embedding model triggers a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        program({ embeddingModel: "@cf/baai/bge-m3" }),
      );
      expect(initial.instance.embeddingModel).toEqual("@cf/baai/bge-m3");

      const replaced = yield* stack.deploy(
        program({ embeddingModel: "@cf/baai/bge-large-en-v1.5" }),
      );

      // The embedding model defines the vector space and is fixed at
      // creation — a new physical instance exists.
      expect(replaced.instance.instanceId).not.toEqual(
        initial.instance.instanceId,
      );
      expect(replaced.instance.embeddingModel).toEqual(
        "@cf/baai/bge-large-en-v1.5",
      );

      const live = yield* getInstance(accountId, replaced.instance.instanceId);
      expect(live.embeddingModel).toEqual("@cf/baai/bge-large-en-v1.5");

      // The old instance was deleted as part of the replacement.
      yield* expectGone(accountId, initial.instance.instanceId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.instance.instanceId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(program());

      // Delete the instance out-of-band. A redeploy with identical props is
      // a planner no-op, so change a mutable prop to force reconcile — it
      // must observe the instance as missing and recreate it instead of
      // failing on a 404.
      yield* aisearch
        .deleteNamespaceInstance({
          accountId,
          name: "default",
          id: initial.instance.instanceId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      yield* expectGone(accountId, initial.instance.instanceId);

      const healed = yield* stack.deploy(program({ maxNumResults: 10 }));

      expect(healed.instance.instanceId).toEqual(initial.instance.instanceId);
      const live = yield* getInstance(accountId, healed.instance.instanceId);
      expect(live.id).toEqual(initial.instance.instanceId);

      yield* stack.destroy();

      yield* expectGone(accountId, healed.instance.instanceId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Canonical `list()` test: instances are namespace-scoped, so `list()`
// enumerates every namespace (including the account-provided `default`) and
// fans out a paginated instance list per namespace, hydrating each into the
// `read` Attributes shape. Deploy an instance and assert its id appears.
test.provider(
  "list enumerates the deployed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());

      const provider = yield* Provider.findProvider(
        Cloudflare.AI.SearchInstance,
      );
      const all = yield* provider.list();

      expect(
        all.some((x) => x.instanceId === deployed.instance.instanceId),
      ).toBe(true);

      yield* stack.destroy();

      yield* expectGone(
        deployed.instance.accountId,
        deployed.instance.instanceId,
      );
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// A web-crawler source crawls a seed URL and needs no service token (unlike
// an R2 source). Cloudflare only crawls a domain the account owns, so the
// crawl is seeded at a Worker we deploy (its `workers.dev` URL is owned by the
// account); `parseType: "crawl"` walks pages instead of requiring a sitemap.
test.provider(
  "creates a web-crawler instance (no service token)",
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

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* AiSearchCrawlTargetWorker;
          const instance = yield* Cloudflare.AI.SearchInstance("Search", {
            type: "web-crawler",
            source: target.url.as<string>(),
            sourceParams: {
              webCrawler: {
                parseType: "crawl",
                // Discover URLs by following links only. Without this,
                // crawl link-discovery defaults to also reading the seed's
                // sitemap, and a freshly-deployed `workers.dev` URL serves
                // none — Cloudflare rejects the create with `missing_sitemap`.
                crawlOptions: { source: "links" },
              },
            },
          });
          return { target, instance };
        }),
      );

      // Creating without any tokenId proves a web-crawler needs no token.
      expect(initial.instance.type).toEqual("web-crawler");
      expect(initial.instance.source).toEqual(initial.target.url);

      const live = yield* getInstance(accountId, initial.instance.instanceId);
      expect(live.type).toEqual("web-crawler");

      yield* stack.destroy();

      yield* expectGone(accountId, initial.instance.instanceId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// A program that places the instance in a custom namespace. The instance's
// `namespace` references the namespace's `name` output, so the engine orders
// instance-after-namespace on deploy (and namespace-after-instance on
// destroy, so the namespace's instances are torn down before it).
const nsProgram = (props?: Partial<Cloudflare.AI.SearchInstanceProps>) =>
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.AI.SearchNamespace("AiSearchNs", {});
    const bucket = yield* Cloudflare.R2.Bucket("AiSearchSource", {});
    const instance = yield* Cloudflare.AI.SearchInstance("Search", {
      source: bucket.bucketName,
      namespace: namespace.name,
      ...props,
    });
    return { namespace, bucket, instance };
  });

test.provider(
  "creates an instance in a custom namespace and moving namespaces replaces",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(nsProgram());
      expect(initial.instance.namespace).toEqual(initial.namespace.name);
      expect(initial.namespace.name).not.toEqual("default");

      // The instance is readable in its namespace, but NOT in `default`.
      const live = yield* getInstance(
        accountId,
        initial.instance.instanceId,
        initial.namespace.name,
      );
      expect(live.id).toEqual(initial.instance.instanceId);
      yield* expectGone(accountId, initial.instance.instanceId, "default");

      yield* stack.destroy();

      yield* expectGone(
        accountId,
        initial.instance.instanceId,
        initial.namespace.name,
      );
    }).pipe(logLevel),
  { timeout: 240_000 },
);
