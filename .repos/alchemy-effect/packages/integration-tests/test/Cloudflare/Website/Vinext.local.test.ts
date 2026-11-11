import * as Cloudflare from "@alchemy.run/cloudflare";
import { isLocalId } from "@alchemy.run/cloudflare/LocalRuntime";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains, expectUrlHeader } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "vinext-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/**
 * Under `alchemy dev` the site runs locally: vinext's own Vite dev server
 * (the RSC environment in workerd behind the alchemy dev proxy) with the
 * auto-provisioned data-cache KV emulated by the local provider.
 */
describe.concurrent(
  "Vinext dev",
  { tags: ["provider:cloudflare", "provider:cloudflare:kv", "provider:cloudflare:website"] },
  () => {
    test.provider(
      "Vinext dev: local dev server renders SSR and serves public files through ASSETS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vinext-dev-",
            tempRoot,
            entries: [".gitignore", "package.json", "vite.config.ts", "app", "public", "worker"],
          });

          const { site, cache } = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Cloudflare.Website.Vinext("VinextLocal", {
                rootDir,
                dev: { port: 0 },
                memo: {
                  include: ["app/**", "public/**", "worker/**", "package.json", "vite.config.ts"],
                },
              });
              // Dedupes by logical id: the data-cache namespace the Vinext
              // resource auto-provisioned.
              const cache = yield* Cloudflare.KV.Namespace("VinextLocalIsrCache");
              return { site, cache };
            }),
          );

          // Local identity: the url points at the alchemy dev proxy, and the
          // cache namespace carries the `dev:` marker (no cloud call ran).
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
          expect(isLocalId(cache.namespaceId)).toBe(true);

          yield* expectUrlContains(`${site.url!}/`, "VINEXT_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "vinext dev SSR home",
          });

          // Static asset from `public/` through the dev server.
          yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext dev static asset",
          });

          // The same file read by a server route through the `ASSETS` binding.
          yield* expectUrlContains(`${site.url!}/api/asset`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext dev ASSETS binding",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 300_000, tags: ["provider:cloudflare", "provider:cloudflare:website", "local"] },
    );

    // alchemy-run/alchemy#2231: tail consumers were dropped on the source
    // provider's dev path.
    test.provider(
      "Vinext dev: a custom main serves and streams its events to tail consumers",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vinext-tail-",
            tempRoot,
            entries: [".gitignore", "package.json", "vite.config.ts", "app", "public", "worker"],
          });

          const { site, consumer } = yield* stack.deploy(
            Effect.gen(function* () {
              const events = yield* Cloudflare.KV.Namespace("VinextTailEvents");
              const consumer = yield* Cloudflare.Worker("VinextTailConsumer", {
                main: pathe.resolve(import.meta.dirname, "fixtures/tail-consumer.ts"),
                env: { EVENTS: events },
                dev: { port: 0 },
              });
              const site = yield* Cloudflare.Website.Vinext("VinextCustomMain", {
                rootDir,
                main: "worker/custom.ts",
                tailConsumers: [consumer],
                streamingTailConsumers: [consumer],
                dev: { port: 0 },
                memo: {
                  include: ["app/**", "public/**", "worker/**", "package.json", "vite.config.ts"],
                },
              });
              return { site, consumer };
            }),
          );

          yield* expectUrlHeader(`${site.url!}/`, "x-alchemy-entry", "custom", {
            timeout: "180 seconds",
            label: "vinext dev custom main",
          });

          // Each poll drives the site again: the consumer may register with
          // the dev registry after the site's first requests.
          const client = yield* HttpClient.HttpClient;
          const recorded = yield* Effect.gen(function* () {
            yield* client.get(`${site.url!}/`).pipe(Effect.flatMap((res) => res.text));
            const res = yield* client.get(`${consumer.url!}/events`);
            return (yield* res.json) as { tail: string[]; stream: string[] };
          }).pipe(
            Effect.orDie,
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: ({ tail, stream }) =>
                tail.some((batch) => batch.includes("vinext-custom-entry")) &&
                stream.some((session) => session.includes("vinext-custom-entry")),
              times: 30,
            }),
          );
          expect(recorded.tail.some((batch) => batch.includes("vinext-custom-entry"))).toBe(true);
          expect(recorded.stream.some((session) => session.includes("vinext-custom-entry"))).toBe(
            true,
          );

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 300_000, tags: ["provider:cloudflare", "provider:cloudflare:website", "local"] },
    );
  },
);
