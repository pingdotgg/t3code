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

// Exercise `QuerySearchLocal` — the current-credentials HTTP implementation of
// the `QuerySearch` binding — from inside an Action. A web-crawler instance
// needs no service token (unlike an R2 source), so teardown stays fast. The
// Action reads instance metadata (`info`) and indexing stats (`stats`), both
// available immediately after create (no waiting on async indexing), proving
// the client talks to the live AI Search REST API with the current creds.
test.provider(
  "QuerySearchLocal: read instance info/stats from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Warm the crawl target first — AI Search fetches the seed synchronously
      // when it validates a web-crawler at create time.
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
          const instance = yield* Cloudflare.AI.SearchInstance("Search", {
            type: "web-crawler",
            source: target.url.as<string>(),
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
              const search = yield* Cloudflare.AI.QuerySearch(instance);
              const instanceId = yield* instance.instanceId;
              const namespace = yield* instance.namespace;

              return Effect.fn(function* () {
                const info = yield* search.info().pipe(
                  Effect.retry({
                    schedule: Schedule.exponential("500 millis"),
                    times: 6,
                  }),
                );
                const stats = yield* search.stats().pipe(
                  Effect.retry({
                    schedule: Schedule.exponential("500 millis"),
                    times: 6,
                  }),
                );
                return {
                  instanceId: yield* instanceId,
                  namespace: yield* namespace,
                  info,
                  stats,
                };
              });
            }).pipe(Effect.provide(Cloudflare.AI.QuerySearchLocal)),
          );

          return yield* Probe({});
        }),
      );

      expect(out.instanceId).toBeTruthy();
      // `info()` round-trips the AI Search REST read through the current creds.
      expect(out.info.id).toEqual(out.instanceId);
      expect(out.info.type).toEqual("web-crawler");
      expect(out.info.namespace).toEqual(out.namespace);
      // `stats()` returns the indexing status counts object.
      expect(out.stats).toBeTypeOf("object");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
