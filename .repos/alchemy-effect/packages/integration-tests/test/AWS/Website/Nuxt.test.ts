import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime (create ~5-15 min, destroy ~5-15 min).
const runLive = !process.env.FAST;

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");

// Clone under the alchemy package so `nuxt`/`nitropack` resolve from the
// workspace's hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [".gitignore", "package.json", "nuxt.config.ts", "app", "server", "public"];

// Under the floci runner the standalone composite deploys only the framework
// dev server (no Lambda/S3/CloudFront), so the standalone test below is
// live-only; the shared-Router test runs in both modes because the Router
// pipeline deploys fully against the emulator, which serves the router's
// edge on a local plain-HTTP port.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive)(
  "AWS.Website.Nuxt",
  { tags: ["provider:aws", "provider:aws:cloudfront", "provider:aws:website", "live"] },
  () => {
    test.provider.skipIf(runEmulated)(
      "deploys SSR on a Lambda Web Function with S3 assets behind CloudFront",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-nuxt-aws-",
            tempRoot,
            entries: fixtureEntries,
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* AWS.Website.Nuxt("NuxtSite", {
                rootDir,
                forceDestroy: true,
                invalidation: { paths: "all", wait: true },
              });
              return { site };
            }),
          );

          const url = deployed.site.url! as string;
          expect(url).toMatch(/^https:\/\//);
          expect(deployed.site.serverUrl).toBeDefined();
          // The server is a Lambda Web Function (the default).
          expect(deployed.site.serverUrl).toContain(".lambda-web.");
          yield* Effect.log(`site url: ${url} | server url: ${deployed.site.serverUrl}`);

          // The Lambda Function URL serves the SSR page directly — isolates
          // server-function health from the CloudFront edge routing.
          yield* expectUrlContains(`${deployed.site.serverUrl!}`, "NUXT_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          });

          // SSR page rendered by the Lambda through CloudFront.
          yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "SSR home page",
          });
          // The fixture's own nuxt.config.ts applied (runtimeConfig marker).
          yield* expectUrlContains(`${url}/`, "config:nuxt-aws-user-config-loaded", {
            label: "user nuxt.config.ts applied",
          });
          // Server API route through the streaming Function URL origin.
          yield* expectUrlContains(`${url}/api/hello?echo=roundtrip`, "NUXT_AWS_API_MARKER", {
            label: "API route",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=roundtrip`, "roundtrip", {
            label: "API route query echo",
          });
          // Public file served from S3 via the KV file manifest.
          yield* expectUrlContains(`${url}/robots.txt`, "nuxt-aws-robots-marker", {
            label: "public asset from S3",
          });
          // Prerendered page (nitro wrote it into .output/public at build
          // time; the edge router serves it from S3 by exact match).
          yield* expectUrlContains(`${url}/prerendered`, "NUXT_AWS_PRERENDERED_MARKER", {
            label: "prerendered page",
          });

          const distributionId = deployed.site.distribution!.distributionId;

          if (!process.env.NO_DESTROY) {
            yield* stack.destroy();
            yield* assertDistributionDeleted(distributionId);
          }
        }),
      { timeout: 2_400_000 },
    );

    test.provider.skipIf(runEmulated)(
      'moves a standalone site from server: "function" onto a Web Function, then several Regions, without downtime',
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-nuxt-aws-fn-",
            tempRoot,
            entries: fixtureEntries,
          });
          const deploy = (props: { server: "function" } | { regions?: string[] }) =>
            stack.deploy(
              Effect.gen(function* () {
                const site = yield* AWS.Website.Nuxt("NuxtFunctionSite", {
                  rootDir,
                  ...props,
                  forceDestroy: true,
                  invalidation: { paths: "all", wait: true },
                });
                return { site };
              }),
            );

          const deployed = yield* deploy({ server: "function" });
          expect(deployed.site.serverUrl).toContain(".lambda-url.");
          const url = `${deployed.site.url!}/`;
          yield* expectUrlContains(url, "NUXT_AWS_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "SSR home page",
          });

          // Dropping `server` moves the site onto a Web Function; the
          // distribution (and its domain) stays, and the site keeps
          // answering throughout.
          const { result: migrated, failures: forward } = yield* probeDuring(
            url,
            "NUXT_AWS_PAGE_MARKER",
            deploy({}),
          );
          expect(migrated.site.serverUrl).toContain(".lambda-web.");
          expect(migrated.site.distribution!.distributionId).toBe(
            deployed.site.distribution!.distributionId,
          );
          expectNoDowntime(forward);

          // Adding Regions gives the server one global domain; CloudFront
          // moves to it and the site's URL stays.
          const { result: global, failures: regional } = yield* probeDuring(
            url,
            "NUXT_AWS_PAGE_MARKER",
            deploy({ regions: ["us-east-1"] }),
          );
          expect(global.site.serverUrl).toContain(".lambda-web.global.");
          expect(global.site.distribution!.distributionId).toBe(
            deployed.site.distribution!.distributionId,
          );
          expectNoDowntime(regional);

          const distributionId = deployed.site.distribution!.distributionId;
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }),
      { timeout: 2_400_000 },
    );

    test.provider.skipIf(runEmulated)(
      'moves a Router-attached site from server: "function" onto a Web Function without downtime',
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-nuxt-aws-router-switch-",
            tempRoot,
            entries: fixtureEntries,
          });
          const deploy = (server: "function" | undefined) =>
            stack.deploy(
              Effect.gen(function* () {
                const router = yield* AWS.Website.Router("FrontDoor", {
                  invalidation: { paths: "all", wait: true },
                });
                const site = yield* AWS.Website.Nuxt("NuxtSite", {
                  rootDir,
                  ...(server === "function" ? { server: "function" as const } : {}),
                  forceDestroy: true,
                  domain: { router },
                });
                return { router, site };
              }),
            );

          const deployed = yield* deploy("function");
          expect(deployed.site.serverUrl).toContain(".lambda-url.");
          const url = `${deployed.router.url as string}/`;
          yield* expectUrlContains(url, "NUXT_AWS_PAGE_MARKER", {
            timeout: "600 seconds",
            label: "SSR via router",
          });

          const { result: migrated, failures: forward } = yield* probeDuring(
            url,
            "NUXT_AWS_PAGE_MARKER",
            deploy(undefined),
          );
          expect(migrated.site.serverUrl).toContain(".lambda-web.");
          expect(migrated.router.distribution.distributionId).toBe(
            deployed.router.distribution.distributionId,
          );
          expectNoDowntime(forward);

          const distributionId = deployed.router.distribution.distributionId;
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }),
      { timeout: 2_400_000 },
    );

    test.provider(
      "serves SSR through a shared Router distribution with Lambda env applied",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-nuxt-aws-router-",
            tempRoot,
            entries: fixtureEntries,
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const router = yield* AWS.Website.Router("FrontDoor", {
                invalidation: { paths: "all", wait: true },
              });
              const site = yield* AWS.Website.Nuxt("NuxtSite", {
                rootDir,
                forceDestroy: true,
                domain: { router },
                env: { NUXT_PUBLIC_ENV_MARKER: "nuxt-aws-live-env-marker" },
              });
              return { router, site };
            }),
          );

          const url = deployed.router.url as string;
          // `https://{id}.cloudfront.net` live; the emulator serves the
          // router's edge on a local plain-HTTP port.
          expect(url).toMatch(runEmulated ? /^http:\/\/localhost:\d+/ : /^https:\/\//);

          // SSR through the ROUTER's distribution (the site registered
          // itself in the router's KV store — no site-owned distribution).
          expect(deployed.site.distribution).toBeUndefined();
          // Generous budget: a fresh router distribution's KVS association +
          // function propagation can lag past 180s on first serve.
          yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
            timeout: "300 seconds",
            label: "SSR via router",
          });
          // Lambda env applied on deploy (parity with the dev-server
          // injection asserted in Nuxt.local.test.ts).
          yield* expectUrlContains(`${url}/`, "env:nuxt-aws-live-env-marker", {
            label: "server.environment on the Lambda",
          });
          // The router's defaultTTL-0 cache policy must not cache SSR
          // responses: two fetches of an SSR page with a per-request value
          // would prove staleness, but the page is deterministic — instead
          // assert the API route (dynamic, no cache-control) round-trips
          // with distinct query strings, which a day-long cached body under
          // CachingOptimized would break.
          yield* expectUrlContains(`${url}/api/hello?echo=router-one`, "router-one", {
            label: "API via router (query one)",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=router-two`, "router-two", {
            label: "API via router (query two)",
          });
          // Static asset from S3 through the router's edge function.
          yield* expectUrlContains(`${url}/robots.txt`, "nuxt-aws-robots-marker", {
            label: "public asset via router",
          });
          // Prerendered page from S3 by exact match.
          yield* expectUrlContains(`${url}/prerendered`, "NUXT_AWS_PRERENDERED_MARKER", {
            label: "prerendered page via router",
          });

          const distributionId = deployed.router.distributionId as string;

          if (!process.env.NO_DESTROY) {
            yield* stack.destroy();
            yield* assertDistributionDeleted(distributionId);
          }
        }),
      { timeout: 2_400_000 },
    );
  },
);

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error): boolean =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
    }),
  );

/**
 * A just-created server endpoint rejects CloudFront with a Function URL
 * authorization 403 for a few seconds after AWS reports it Active, and there
 * is no control-plane signal to wait for. A cutover may hit a short run of
 * exactly that response; anything else, or a longer run, is downtime.
 */
const isEndpointSettling = (failure: string) =>
  failure.includes(" 403 ") && failure.includes("Function URL authorization");

const expectNoDowntime = (failures: string[]) => {
  expect(failures.filter((failure) => !isEndpointSettling(failure))).toEqual([]);
  expect(failures.filter(isEndpointSettling).length).toBeLessThanOrEqual(15);
};

/**
 * Run `effect` while requesting `url` once a second, and report every
 * request that did not return the page (status and time).
 */
const probeDuring = <A, E, R>(url: string, marker: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const failures = yield* Ref.make<string[]>([]);
    const once = client.get(url).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (body) =>
          response.status === 200 && body.includes(marker)
            ? undefined
            : // Who answered (CloudFront vs the origin) and what it said.
              `${response.status} [${response.headers["x-cache"] ?? ""}] ${body.slice(0, 160)}`,
        ),
      ),
      Effect.catch((error) => Effect.succeed(`error ${String(error)}`)),
      Effect.flatMap((failure) =>
        failure === undefined
          ? Effect.void
          : Ref.update(failures, (all) => [...all, `${new Date().toISOString()} ${failure}`]),
      ),
    );
    const prober = yield* Effect.forkChild(once.pipe(Effect.repeat(Schedule.spaced("1 second"))));
    const result = yield* effect;
    yield* Fiber.interrupt(prober);
    return { result, failures: yield* Ref.get(failures) };
  });

test.provider(
  'regions with server: "function" is a type error, and fails at plan in untyped JS',
  (stack) =>
    Effect.gen(function* () {
      const exit = yield* stack
        .plan(
          AWS.Website.Nuxt("RegionsOnFunction", {
            server: "function",
            // @ts-expect-error `regions` only exists on the Web Function server form.
            regions: ["us-east-1"],
          }),
        )
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      expect(exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "").toContain(
        "regions needs the Web Function server",
      );
    }),
  { tags: ["provider:aws", "provider:aws:website", "live"] },
);

// Type-level: each server form only accepts its own props.
export const _serverFormTypeChecks = () => [
  AWS.Website.Nuxt("Web", { regions: ["us-east-1"], maxEnvironments: 10 }),
  AWS.Website.Nuxt("Fn", { server: "function", memorySize: 4096, architecture: "x86_64" }),
  // @ts-expect-error `memorySize` only exists on the `server: "function"` form.
  AWS.Website.Nuxt("WebWithMemory", { memorySize: 4096 }),
  // @ts-expect-error `maxEnvironments` only exists on the Web Function form.
  AWS.Website.Nuxt("FnWithEnvironments", { server: "function", maxEnvironments: 10 }),
  // @ts-expect-error `imageOptimization` only exists on the `server: "function"` form.
  AWS.Website.Nextjs("NextWebWithImageMemory", { imageOptimization: { memorySize: 2048 } }),
];
