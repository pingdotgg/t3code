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
  "react-router-app",
);

// Clone under the alchemy package so `@react-router/dev`, `react-router`,
// `@react-router/node`, `isbot`, `react`, and `vite` resolve from the
// workspace's node_modules (the fixture has none of its own).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "react-router.config.ts",
  "vite.config.ts",
  "app",
  "public",
];

// Under the floci runner the standalone composite deploys only the framework
// dev server (no Lambda/S3/CloudFront), so the standalone test below is
// live-only; the shared-Router test runs in both modes because the Router
// pipeline deploys fully against the emulator, which serves the router's
// edge on a local plain-HTTP port.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive)("AWS.Website.ReactRouter", () => {
  test.provider.skipIf(runEmulated)(
    "deploys SSR on a streaming Lambda URL with S3 assets behind CloudFront",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-react-router-aws-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.ReactRouter("ReactRouterSite", {
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
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // The Lambda Function URL serves the SSR page directly — isolates
        // server-function health from the CloudFront edge routing.
        yield* expectUrlContains(
          `${deployed.site.serverUrl!}`,
          "REACT_ROUTER_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "REACT_ROUTER_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // The fixture's own vite.config.ts applied (its `define` marker).
        yield* expectUrlContains(
          `${url}/`,
          "config:react-router-aws-user-config-loaded",
          { label: "user vite.config.ts applied" },
        );
        // Resource route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "REACT_ROUTER_AWS_API_MARKER",
          { label: "resource route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "resource route query echo" },
        );
        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "react-router-aws-robots-marker",
          { label: "public asset from S3" },
        );
        // Client bundle from S3 — the SSR document modulepreloads it, so a
        // broken asset upload breaks hydration silently otherwise.
        yield* expectUrlContains(`${url}/`, "/assets/", {
          label: "client asset reference",
        });

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
          prefix: "alchemy-react-router-aws-router-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("FrontDoor", {
              invalidation: { paths: "all", wait: true },
            });
            const site = yield* AWS.Website.ReactRouter("ReactRouterSite", {
              rootDir,
              forceDestroy: true,
              domain: { router },
              env: {
                REACT_ROUTER_ENV_MARKER: "react-router-aws-live-env-marker",
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

        // SSR through the ROUTER's distribution (the site registered itself
        // in the router's KV store — no site-owned distribution).
        expect(deployed.site.distribution).toBeUndefined();
        // Generous budget: a fresh router distribution's KVS association +
        // function propagation can lag past 180s on first serve.
        yield* expectUrlContains(`${url}/`, "REACT_ROUTER_AWS_PAGE_MARKER", {
          timeout: "300 seconds",
          label: "SSR via router",
        });
        // Lambda env applied on deploy, read from a route loader (parity
        // with the dev-server injection asserted in the local suite).
        yield* expectUrlContains(
          `${url}/`,
          "env:react-router-aws-live-env-marker",
          { label: "server.environment on the Lambda" },
        );
        // The router's defaultTTL-0 cache policy must not cache SSR
        // responses: the resource route round-trips with distinct query
        // strings, which a day-long cached body would break.
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-one`,
          "router-one",
          { label: "resource route via router (query one)" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-two`,
          "router-two",
          { label: "resource route via router (query two)" },
        );
        // Static asset from S3 through the router's edge function.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "react-router-aws-robots-marker",
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
