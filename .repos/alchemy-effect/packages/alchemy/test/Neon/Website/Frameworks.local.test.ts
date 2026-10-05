import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { bodyContaining, exampleRoot } from "./Fixture.ts";
import { frameworks } from "./Frameworks.ts";
import { browserRoundtrip } from "./Browser.ts";

const { test } = Test.make({ providers: providers(), dev: true });

describe.sequential(
  "Neon Website native frameworks",
  { tags: ["provider:neon", "provider:neon:website", "local"] },
  () => {
    for (const { slug, name, website } of frameworks) {
      // Each dev server spawns 1-3 GiB toolchain children; the matrix cannot
      // share a 4 GiB budget with a long-lived suite process.
      test.provider.skipIf(!!process.env.FAST)(
        slug,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* exampleRoot(slug);
            const site = yield* stack.deploy(
              Effect.gen(function* () {
                return yield* website("Web", {
                  rootDir,
                  env: { GREETING: `Hello from ${name} on Neon!` },
                });
              }),
            );
            expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
            expect(site.function).toBeUndefined();
            expect(site.project).toBeUndefined();
            expect(site.branch).toBeUndefined();
            expect(site.domain).toBeUndefined();
            yield* bodyContaining(`${site.url}/`, name);
            const asset = yield* HttpClient.get(`${site.url}/example.json`);
            expect(asset.status).toBe(200);
            expect(yield* asset.json).toHaveProperty("framework");
            if (slug === "nextjs") {
              const stream = yield* HttpClient.get(`${site.url}/api/stream`);
              expect(yield* stream.text).toBe(
                "data: first\n\ndata: second\n\n",
              );
              const image = yield* HttpClient.get(`${site.url}/logo.svg`);
              expect(image.headers["content-type"]).toContain("image/svg+xml");
              const redirect = yield* HttpClient.get(
                `${site.url}/redirect`,
              ).pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  redirect: "manual",
                }),
              );
              expect(redirect.status).toBe(307);
              const location = new URL(redirect.headers.location!);
              expect(["localhost", "127.0.0.1"]).toContain(location.hostname);
              expect(location.port).toBe(new URL(String(site.url)).port);
              expect(location.pathname + location.search).toBe(
                "/?redirected=yes",
              );
              expect(
                (yield* HttpClient.get(`${site.url}/not-a-real-page`)).status,
              ).toBe(404);
            }
            yield* browserRoundtrip(String(site.url), slug);
            yield* stack.destroy();
          }),
        { timeout: 120_000 },
      );
    }
  },
);
