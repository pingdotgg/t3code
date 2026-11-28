import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime (create ~5-15 min, destroy ~5-15 min).
const runLive = !process.env.FAST;

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "astro-app");

// Clone under the alchemy package so `astro` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [".gitignore", "package.json", "astro.config.mjs", "src", "public"];

// Skipped under the floci runner: in dev the composite deploys only the
// framework dev server (no Lambda/S3/CloudFront), so this test's live
// topology assertions are meaningless there. Dev behavior is covered by
// the co-located Astro.local.test.ts suite.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

// Plan-only: a static site's topology (no Lambda) is decided at plan time,
// so this needs no CloudFront lifecycle and runs outside the live gate.
describe.skipIf(runEmulated)(
  "AWS.Website.Astro plan",
  { tags: ["provider:aws", "provider:aws:website"] },
  () => {
    test.provider(
      "a config-file output 'static' plans an assets-only site without the astro.output prop",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-astro-aws-static-config-",
            tempRoot,
            entries: fixtureEntries.filter((entry) => entry !== "astro.config.mjs"),
          });
          yield* fs.writeFileString(
            path.join(rootDir, "astro.config.mjs"),
            'import { defineConfig } from "astro/config";\n\nexport default defineConfig({ output: "static" });\n',
          );

          const plan = yield* stack.plan(
            AWS.Website.Astro("AstroStaticConfigSite", { rootDir, forceDestroy: true }),
          );
          const types = Object.values(plan.resources).map((node) => node.resource.Type);
          expect(types).toContain("AWS.S3.Bucket");
          expect(types.filter((type) => type.startsWith("AWS.Lambda."))).toEqual([]);
        }),
      { tags: ["live"] },
    );
  },
);

describe.skipIf(!runLive || runEmulated)(
  "AWS.Website.Astro",
  { tags: ["provider:aws", "provider:aws:cloudfront", "provider:aws:website", "live"] },
  () => {
    test.provider(
      "deploys SSR on a Lambda Web Function with S3 assets behind CloudFront",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-astro-aws-",
            tempRoot,
            entries: fixtureEntries,
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* AWS.Website.Astro("AstroSite", {
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
          yield* expectUrlContains(`${deployed.site.serverUrl!}`, "ASTRO_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          });

          // SSR page rendered by the Lambda through CloudFront.
          yield* expectUrlContains(`${url}/`, "ASTRO_AWS_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "SSR home page",
          });
          // API route through the streaming Function URL origin.
          yield* expectUrlContains(`${url}/api/hello?echo=roundtrip`, "ASTRO_AWS_API_MARKER", {
            label: "API route",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=roundtrip`, "roundtrip", {
            label: "API route query echo",
          });
          // Public file served from S3 via the KV file manifest.
          yield* expectUrlContains(`${url}/robots.txt`, "astro-aws-robots-marker", {
            label: "public asset from S3",
          });
          // Prerendered page (astro wrote it into dist/client at build time;
          // the edge router serves it from S3 by directory-index match).
          yield* expectUrlContains(`${url}/prerendered/`, "ASTRO_AWS_PRERENDERED_MARKER", {
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
