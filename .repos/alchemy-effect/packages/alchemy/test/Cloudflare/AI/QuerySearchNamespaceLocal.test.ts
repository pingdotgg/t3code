import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
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

// Exercise `QuerySearchNamespaceLocal` — the current-credentials HTTP
// implementation of the `QuerySearchNamespace` binding — from inside an Action.
// A custom namespace holds a web-crawler instance (no service token, fast
// teardown). The Action lists the namespace's instances and reads one back via
// `.get(instanceId).info()`, proving the namespace client talks to the live AI
// Search REST API with the current creds.
test.provider(
  "QuerySearchNamespaceLocal: list + get an instance from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Warm the crawl target first — AI Search validates a web-crawler seed
      // synchronously at create time.
      const warmed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AiSearchCrawlTargetWorker;
        }),
      );
      const client = yield* HttpClient.HttpClient;
      yield* client.get(warmed.url as string).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`crawl target not ready: ${res.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* AiSearchCrawlTargetWorker;
          const namespace = yield* Cloudflare.AI.SearchNamespace(
            "SearchNs",
            {},
          );
          const instance = yield* Cloudflare.AI.SearchInstance("Search", {
            type: "web-crawler",
            source: target.url.as<string>(),
            namespace: namespace.name,
            sourceParams: {
              webCrawler: {
                parseType: "crawl",
                crawlOptions: { source: "links" },
              },
            },
          });

          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const ns = yield* Cloudflare.AI.QuerySearchNamespace(namespace);
              const instanceId = yield* instance.instanceId;

              return Effect.fn(function* () {
                const id = yield* instanceId;
                const list = yield* ns.list().pipe(
                  Effect.retry({
                    schedule: Schedule.exponential("500 millis"),
                    times: 6,
                  }),
                );
                const info = yield* ns
                  .get(id)
                  .info()
                  .pipe(
                    Effect.retry({
                      schedule: Schedule.exponential("500 millis"),
                      times: 6,
                    }),
                  );
                return {
                  instanceId: id,
                  ids: list.result.map((i) => i.id),
                  info,
                };
              });
            }).pipe(Effect.provide(Cloudflare.AI.QuerySearchNamespaceLocal)),
          );

          return yield* Probe({});
        }),
      );

      expect(out.instanceId).toBeTruthy();
      // `list()` enumerates the namespace's instances via the current creds.
      expect(out.ids).toContain(out.instanceId);
      // `.get(id).info()` scopes a single-instance read to this namespace.
      expect(out.info.id).toEqual(out.instanceId);
      expect(out.info.type).toEqual("web-crawler");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
