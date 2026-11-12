import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectClientChunkContains, expectUrlContains, expectUrlHeader } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "vinext-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const publicMarker = "VINEXT_PUBLIC_ENV_MARKER";

describe.concurrent(
  "Vinext",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:kv", "provider:cloudflare:website", "live"],
  },
  () => {
    test.provider(
      "Vinext: deploys App Router SSR, inlines declared public env and serves public files through ASSETS",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vinext-",
            tempRoot,
            entries: [".gitignore", "package.json", "vite.config.ts", "app", "public", "worker"],
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Vinext("VinextSite", {
              rootDir,
              workersDev: { enabled: true },
              env: { NEXT_PUBLIC_SITE_MARKER: publicMarker },
              memo: {
                include: ["app/**", "public/**", "worker/**", "package.json", "vite.config.ts"],
              },
            }),
          );
          expect(site.url).toBeDefined();
          yield* expectWorkerExists(site.workerName, accountId);

          yield* expectUrlContains(`${site.url!}/`, "VINEXT_PAGE_MARKER", {
            timeout: "90 seconds",
            label: "vinext SSR home",
          });

          // The declared `NEXT_PUBLIC_*` value is inlined into the deployed
          // client bundle.
          yield* expectClientChunkContains(
            site.url!,
            pathe.join(rootDir, "dist", "client"),
            publicMarker,
            { timeout: "60 seconds", label: "vinext public env" },
          );

          // Static asset from `public/`.
          yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext static asset",
          });

          // The same file read by a server route through the `ASSETS` binding.
          yield* expectUrlContains(`${site.url!}/api/asset`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext ASSETS binding",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    // alchemy-run/alchemy#2234: the documented custom `main` was rejected
    // beside the source provider (`"source" is mutually exclusive with "main"`).
    test.provider(
      "Vinext: deploys a custom main",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vinext-main-",
            tempRoot,
            entries: [".gitignore", "package.json", "vite.config.ts", "app", "public", "worker"],
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Vinext("VinextCustomMain", {
              rootDir,
              main: "worker/custom.ts",
              workersDev: { enabled: true },
              memo: {
                include: ["app/**", "public/**", "worker/**", "package.json", "vite.config.ts"],
              },
            }),
          );

          yield* expectUrlHeader(`${site.url!}/`, "x-alchemy-entry", "custom", {
            timeout: "90 seconds",
            label: "vinext custom main",
          });
          yield* expectUrlContains(`${site.url!}/`, "VINEXT_PAGE_MARKER", {
            timeout: "60 seconds",
            label: "vinext SSR through the custom main",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );
  },
);
