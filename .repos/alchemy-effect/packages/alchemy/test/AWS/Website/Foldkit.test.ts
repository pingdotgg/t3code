import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Skipped under --fast (FAST=1) (same gate
// as the AWS.CloudFront and AWS.Website.Vite suites).
const runLive = !process.env.FAST;

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "foldkit-app",
);

// Clone under the alchemy package so `vite`, `foldkit`, and
// `@foldkit/vite-plugin` resolve from the workspace's hoisted node_modules
// (the fixture has none of its own). Vite's `vite:build-html` plugin also
// expresses emitted asset paths relative to the cwd, so the clone has to
// live under the same workspace root.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

// Skipped under the floci runner: in dev the composite deploys only the
// framework dev server (no Lambda/S3/CloudFront), so this test's live
// topology assertions are meaningless there. Dev behavior is covered by
// the co-located Foldkit.local.test.ts suite.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive || runEmulated)("AWS.Website.Foldkit", () => {
  // The resource's reason to exist: a Foldkit app routes on the client, so
  // the deployment is assets-only and deep links fall back to the shell
  // without the caller configuring anything.
  test.provider(
    "deploys the foldkit client build to S3 behind CloudFront with SPA fallback",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-aws-live-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            // Deliberately no `spa` — the default is what's under test.
            const site = yield* AWS.Website.Foldkit("FoldkitSite", {
              rootDir,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        // Assets-only: a Foldkit app is client-only, so the composite never
        // creates a server function.
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.serverUrl).toBeUndefined();

        // The built index page serves from the edge.
        yield* expectUrlContains(`${url}/`, "FOLDKIT_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "index",
        });
        // publicDir passthrough landed in the bucket.
        yield* expectUrlContains(`${url}/robots.txt`, "User-agent", {
          label: "public asset",
        });
        // SPA fallback (the composite's default): a deep link boots the app
        // instead of 404ing, and the Foldkit router resolves the route.
        yield* expectUrlContains(
          `${url}/counter/42`,
          "FOLDKIT_AWS_PAGE_MARKER",
          {
            label: "spa fallback",
          },
        );

        yield* stack.destroy();
      }),
    { timeout: 2_400_000 },
  );
});
