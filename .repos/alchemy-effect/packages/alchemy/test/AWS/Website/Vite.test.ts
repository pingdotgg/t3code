import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Skipped under --fast (FAST=1) (same gate
// as the AWS.CloudFront suites).
const runLive = !process.env.FAST;

// The emulated pipeline test runs under the floci runner
// (`pnpm test:aws:floci`), where every pipeline provider resolves its local
// (emulator-backed) variant.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

const viteFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "vite-app",
);
const staticFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "static-site",
);

// Clone under the alchemy package so `vite` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

// Also skipped under the floci runner (`runEmulated`): in dev the composite
// deploys nothing but the vite dev server, so the live CloudFront topology
// this test asserts never exists. The emulated pipeline test below and
// Vite.local.test.ts cover the dev-mode behavior.
describe.skipIf(!runLive || runEmulated)("AWS.Website.Vite", () => {
  test.provider(
    "deploys the vite build to S3 behind CloudFront with SPA fallback",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(viteFixtureDir, {
          prefix: "alchemy-vite-aws-live-",
          tempRoot,
          entries: [
            ".gitignore",
            "package.json",
            "index.html",
            "src",
            "public",
          ],
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Vite("ViteSite", {
              rootDir,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        // Assets-only: the composite never creates a server function.
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.serverUrl).toBeUndefined();

        // The built index page serves from the edge.
        yield* expectUrlContains(`${url}/`, "VITE_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "index",
        });
        // publicDir passthrough landed in the bucket.
        yield* expectUrlContains(`${url}/robots.txt`, "User-agent", {
          label: "public asset",
        });
        // SPA fallback (the composite's default): misses serve the shell.
        yield* expectUrlContains(
          `${url}/missing/client/route`,
          "VITE_AWS_PAGE_MARKER",
          { label: "spa fallback" },
        );

        yield* stack.destroy();
      }),
    { timeout: 2_400_000 },
  );
});

// The Vite composite intentionally never deploys the static pipeline under
// `alchemy dev` (dev IS the vite dev server — see Vite.local.test.ts), so
// its deploy path cannot be exercised in a dev-mode test. This test pins the
// SAME underlying pipeline (`makeKvSite`: bucket + AssetDeployment +
// KvEntries + KvRoutesUpdate + distribution + invalidation) against the
// emulator via StaticSite, which deploys the full pipeline in dev when no
// `dev` prop is set. This is the regression net for non-dualized pipeline
// providers — the class of bug that previously only surfaced in
// `alchemy dev` of the examples (Files/KvEntries/RoutesUpdate hitting real
// AWS from an emulated stack).
describe.skipIf(!runEmulated)("AWS.Website static pipeline (emulated)", () => {
  test.provider(
    "deploys the full S3 + CloudFront + KVS pipeline against the emulator",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("PipelineSite", {
              path: staticFixtureDir,
              spa: true,
              forceDestroy: true,
              invalidation: { paths: "all" },
            });
            return { site };
          }),
        );

        // Every pipeline resource reconciled against the emulator: the
        // distribution identity has AWS shape but was minted locally.
        const bucketName = deployed.site.bucket!.bucketName as string;
        expect(bucketName).toBeTruthy();
        expect(deployed.site.distribution!.distributionId).toBeTruthy();
        expect(deployed.site.files!.version).toBeTruthy();

        // Out-of-band proof the assets landed in the emulator's S3 (the
        // harness pins distilled to the emulator in dev runs).
        const listed = yield* s3.listObjectsV2({ Bucket: bucketName });
        const keys = (listed.Contents ?? []).flatMap((object) =>
          object.Key !== undefined ? [object.Key] : [],
        );
        expect(keys.some((key) => key.endsWith("index.html"))).toBe(true);
        expect(keys.some((key) => key.endsWith("styles.css"))).toBe(true);
        expect(keys.some((key) => key.endsWith("about.html"))).toBe(true);

        yield* stack.destroy();

        // The bucket is gone from the emulator after destroy.
        const gone = yield* s3.listObjectsV2({ Bucket: bucketName }).pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 300_000 },
  );
});
