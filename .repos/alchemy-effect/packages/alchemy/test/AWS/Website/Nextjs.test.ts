import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the OpenNext build plus the
// CloudFront lifecycle dominate the runtime (create ~10-20 min, destroy
// ~5-15 min).
const runLive = !process.env.FAST;

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

/**
 * Run a command to completion in a child process (Effect-wrapped spawn —
 * the suite shares one bun process, so a sync spawn would stall every
 * concurrently running test). Fails with the combined output on a
 * non-zero exit.
 */
const run = (options: {
  cmd: string;
  args: string[];
  cwd: string;
}): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new Error(
                `${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`,
              ),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

// Skipped under the floci runner: in dev the composite deploys only the
// framework dev server (no Lambda/S3/CloudFront), so this test's live
// topology assertions are meaningless there. Dev behavior is covered by
// the co-located Nextjs.local.test.ts suite.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive || runEmulated)("AWS.Website.Nextjs", () => {
  test.provider(
    "deploys the OpenNext topology: streaming SSR Lambda, S3 assets, image optimizer, ISR wiring",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // OpenNext detect the workspace as a monorepo and trace the server
        // bundle against bun's isolated-install symlink store, which drops
        // transitive deps (e.g. @swc/helpers) from the shipped node_modules.
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-",
          entries: fixtureEntries,
        });
        // Hoisted install in the clone so output tracing sees a plain
        // node_modules tree — the representative user-project shape.
        yield* run({
          cmd: "bun",
          args: ["install", "--linker=hoisted"],
          cwd: rootDir,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nextjs("NextjsSite", {
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
        expect(deployed.site.imageUrl).toBeDefined();
        expect(deployed.site.revalidationQueue).toBeDefined();
        expect(deployed.site.tagCacheTable).toBeDefined();
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // The Lambda Function URL serves the SSR page directly — isolates
        // server-function health from the CloudFront edge routing.
        yield* expectUrlContains(
          `${deployed.site.serverUrl!}`,
          "NEXTJS_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // App Router API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NEXTJS_AWS_API_MARKER",
          { label: "API route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "API route query echo" },
        );
        // Statically-rendered page: prerendered into the ISR cache at build
        // time, served by the server function through the S3 incremental
        // cache — proves the cache seed upload and the cache-bucket IAM.
        yield* expectUrlContains(`${url}/static`, "NEXTJS_AWS_STATIC_MARKER", {
          label: "static (prerendered) page",
        });
        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "nextjs-aws-robots-marker",
          {
            label: "public asset from S3",
          },
        );
        // Client asset (hashed chunk) served from S3: the SSR page links
        // /_next/static/* files uploaded by the asset deployment.
        expect(deployed.site.files?.files).toBeDefined();

        // Image optimization: /_next/image is routed by the edge function
        // to the dedicated optimizer Lambda, which loads the original from
        // the asset bucket and returns an optimized image.
        const client = yield* HttpClient.HttpClient;
        const imageUrl = `${url}/_next/image?url=%2Fpixel.png&w=64&q=75`;
        const imageResponse = yield* client.get(imageUrl).pipe(
          Effect.filterOrFail(
            (response): boolean => response.status === 200,
            (response) =>
              new Error(`/_next/image returned status ${response.status}`),
          ),
          Effect.retry({
            schedule: Schedule.exponential("2 seconds"),
            times: 8,
          }),
        );
        expect(imageResponse.status).toBe(200);
        expect(imageResponse.headers["content-type"] ?? "").toMatch(/^image\//);

        const distributionId = deployed.site.distribution!.distributionId;

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
