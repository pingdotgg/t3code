import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import {
  expectDirectStatus,
  expectUrlContains,
} from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Skipped under --fast (FAST=1) (same gate
// as the AWS.CloudFront suites).
const runLive = !process.env.FAST;

// Under the floci runner the full pipeline (bucket + files + KVS +
// distribution) deploys against the emulator, which serves the
// distribution's edge on a local plain-HTTP port — so the whole test runs
// in both modes; only the URL-shape assertions differ.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/static-site", import.meta.url),
);

const INDEX_MARKER = "alchemy-aws-staticsite-index-marker";
const ABOUT_MARKER = "alchemy-aws-staticsite-about-marker";
const CSS_MARKER = "alchemy-aws-staticsite-css-marker";

describe.skipIf(!runLive)("AWS.Website.StaticSite", () => {
  test.provider(
    "standalone SPA serves index, pretty URLs, and falls back on misses; errorPage update returns real 404s",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Phase 1: standalone SPA. Misses fall back to index.html with 200.
        const spa = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("Site", {
              path: fixtureDir,
              spa: true,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url = spa.site.url! as string;
        // `https://{id}.cloudfront.net` live; the emulator serves the
        // distribution's edge on a local plain-HTTP port.
        expect(url).toMatch(
          runEmulated ? /^http:\/\/localhost:\d+/ : /^https:\/\//,
        );

        // urls contract (cloudfront-default arm): a domain-less site
        // serves only at the distribution's own URL, and `url` is
        // always `urls[0]`.
        expect(spa.site.urls).toEqual([spa.site.distribution!.url]);
        expect(url).toBe(spa.site.urls[0]);

        // Root serves the index page. Generous first-request budget: the
        // distribution just reached Deployed but edge propagation can lag.
        yield* expectUrlContains(`${url}/`, INDEX_MARKER, {
          timeout: "180 seconds",
          label: "index",
        });
        // Exact asset paths hit S3 (proves the OAC bucket policy works).
        yield* expectUrlContains(`${url}/styles.css`, CSS_MARKER, {
          label: "css asset",
        });
        // Pretty URL: /about -> about.html via the edge KV lookup.
        yield* expectUrlContains(`${url}/about`, ABOUT_MARKER, {
          label: "pretty url",
        });
        // SPA fallback: unknown path serves the app shell with a 200.
        yield* expectUrlContains(`${url}/missing/client/route`, INDEX_MARKER, {
          label: "spa fallback",
        });

        // Phase 2: switch to a real-404 static site with an error page.
        const site404 = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("Site", {
              path: fixtureDir,
              errorPage: "404.html",
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url404 = site404.site.url! as string;
        // Content still serves.
        yield* expectUrlContains(`${url404}/about`, ABOUT_MARKER, {
          label: "pretty url after update",
        });
        // Misses now return a real 404 status.
        yield* expectDirectStatus(`${url404}/definitely/not/here`, 404, {
          timeout: "120 seconds",
          label: "404 status",
        });

        const distributionId = site404.site.distribution!.distributionId;

        yield* stack.destroy();
        yield* assertDistributionDeleted(distributionId);
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
