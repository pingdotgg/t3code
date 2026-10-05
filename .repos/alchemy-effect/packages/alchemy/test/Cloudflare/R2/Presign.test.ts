import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import PresignRemoteWorker, {
  PresignRemoteBucket,
} from "./fixtures/presign/remote-worker.ts";
import { presignRoundTrip } from "./fixtures/presign/roundtrip.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Deployed: the Worker mints presigned URLs with S3 credentials derived from
 * a scoped API token, and an unauthenticated client uploads/downloads
 * directly against R2's S3 endpoint.
 */
test.provider(
  "deployed Worker presigns PUT and GET URLs for R2",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* PresignRemoteBucket;
          const worker = yield* PresignRemoteWorker;
          return { bucket, worker };
        }),
      );

      const { putUrl, getUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/deployed file.txt",
      );
      for (const url of [putUrl, getUrl]) {
        const parsed = new URL(url);
        expect(parsed.hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
        expect(
          parsed.pathname.startsWith(`/${deployed.bucket.bucketName}/`),
        ).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
    ],
    timeout: 180_000,
  },
);

/**
 * Deployed async Worker: `Cloudflare.R2.S3Credentials` injects token-derived
 * credentials as a secret, and `aws4fetch` presigns against R2.
 */
test.provider(
  "deployed async Worker presigns with S3Credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("PresignAsyncBucket", {
            forceDestroy: true,
          });
          const worker = yield* Cloudflare.Worker("PresignAsyncWorker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/presign/async-worker.ts",
            ),
            env: {
              BUCKET: bucket,
              BUCKET_S3: Cloudflare.R2.S3Credentials(bucket, {
                access: "read-write",
              }),
            },
          });
          return { bucket, worker };
        }),
      );

      const { putUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/async deployed.txt",
      );
      expect(new URL(putUrl).hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
    ],
    timeout: 180_000,
  },
);
