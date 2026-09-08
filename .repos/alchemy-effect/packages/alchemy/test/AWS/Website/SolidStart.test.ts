import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime (create ~5-15 min, destroy ~5-15 min).
const runLive = !process.env.FAST;

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "solidstart-app",
);

// Clone under the alchemy package so `@solidjs/start`, `vite`, and
// `@solidjs/vite-plugin-nitro-2` resolve from the workspace's hoisted
// node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "src",
  "public",
];

// Under the floci runner the standalone composite deploys only the framework
// dev server (no Lambda/S3/CloudFront), so the standalone test below is
// live-only; the shared-Router test runs in both modes because the Router
// pipeline deploys fully against the emulator, which serves the router's
// edge on a local plain-HTTP port.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive)("AWS.Website.SolidStart", () => {
  test.provider.skipIf(runEmulated)(
    "deploys SSR on a streaming Lambda URL with S3 assets behind CloudFront",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-aws-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.SolidStart("SolidStartSite", {
              rootDir,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
              // Forwarded into the nitro plugin the integration appends —
              // proves nitro options reach the build.
              nitro: { prerender: { routes: ["/prerendered"] } },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        expect(deployed.site.serverUrl).toBeDefined();
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // The Lambda Function URL serves the SSR page directly — isolates
        // server-function health from the CloudFront edge routing.
        yield* expectUrlContains(
          `${deployed.site.serverUrl!}`,
          "SOLIDSTART_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "SOLIDSTART_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // The fixture's own vite.config.ts applied (its `define` marker).
        yield* expectUrlContains(
          `${url}/`,
          "config:solidstart-aws-user-config-loaded",
          { label: "user vite.config.ts applied" },
        );
        // API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "SOLIDSTART_AWS_API_MARKER",
          { label: "API route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "API route query echo" },
        );
        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "solidstart-aws-robots-marker",
          { label: "public asset from S3" },
        );
        // Prerendered into `.output/public` at build time (via the `nitro`
        // prop's `prerender.routes`) and served from S3 by exact match at
        // the edge — no Lambda invocation.
        yield* expectUrlContains(
          `${url}/prerendered`,
          "SOLIDSTART_AWS_PRERENDERED_MARKER",
          { label: "prerendered page from S3" },
        );

        const distributionId = deployed.site.distribution!.distributionId;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
      }),
    { timeout: 2_400_000 },
  );

  test.provider(
    "serves SSR through a shared Router distribution with Lambda env applied",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-aws-router-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("FrontDoor", {
              invalidation: { paths: "all", wait: true },
            });
            const site = yield* AWS.Website.SolidStart("SolidStartSite", {
              rootDir,
              forceDestroy: true,
              domain: { router },
              env: {
                SOLIDSTART_ENV_MARKER: "solidstart-aws-live-env-marker",
              },
            });
            return { router, site };
          }),
        );

        const url = deployed.router.url as string;
        // `https://{id}.cloudfront.net` live; the emulator serves the
        // router's edge on a local plain-HTTP port.
        expect(url).toMatch(
          runEmulated ? /^http:\/\/localhost:\d+/ : /^https:\/\//,
        );

        // SSR through the ROUTER's distribution (the site registered
        // itself in the router's KV store — no site-owned distribution).
        expect(deployed.site.distribution).toBeUndefined();
        // Generous budget: a fresh router distribution's KVS association +
        // function propagation can lag past 180s on first serve.
        yield* expectUrlContains(`${url}/`, "SOLIDSTART_AWS_PAGE_MARKER", {
          timeout: "300 seconds",
          label: "SSR via router",
        });
        // Lambda env applied on deploy (parity with the dev-server
        // injection asserted in SolidStart.local.test.ts).
        yield* expectUrlContains(
          `${url}/`,
          "env:solidstart-aws-live-env-marker",
          { label: "server.environment on the Lambda" },
        );
        // The router's defaultTTL-0 cache policy must not cache SSR
        // responses: the API route round-trips with distinct query strings,
        // which a day-long cached body would break.
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-one`,
          "router-one",
          { label: "API via router (query one)" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-two`,
          "router-two",
          { label: "API via router (query two)" },
        );
        // Static asset from S3 through the router's edge function.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "solidstart-aws-robots-marker",
          { label: "public asset via router" },
        );

        const distributionId = deployed.router.distributionId as string;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
      }),
    { timeout: 2_400_000 },
  );
});

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error): boolean =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );
