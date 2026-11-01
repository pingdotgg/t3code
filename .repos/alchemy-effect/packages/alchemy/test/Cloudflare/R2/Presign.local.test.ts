import * as Cloudflare from "@/Cloudflare/index.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import PresignLocalWorker, {
  PresignLocalBucket,
} from "./fixtures/presign/local-worker.ts";
import PresignRemoteWorker, {
  PresignRemoteBucket,
} from "./fixtures/presign/remote-worker.ts";
import { presignRoundTrip } from "./fixtures/presign/roundtrip.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Under `alchemy dev` a locally-emulated bucket is served on the Worker's
 * local S3 endpoint with no extra configuration: the same
 * `PresignPutObject`/`PresignGetObject` code mints URLs that point at the dev
 * server, an unauthenticated client uploads through them, and the Worker's
 * native binding reads the object back from the same local simulator.
 */
test.provider(
  "presigned URLs round-trip against a locally-emulated bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* PresignLocalBucket;
          const worker = yield* PresignLocalWorker;
          return { bucket, worker };
        }),
      );

      // `dev:` name + localhost URL — proof no cloud call ran
      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const { putUrl, getUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/local file.txt",
      );
      const prefix = `${deployed.worker.url}/cdn-cgi/local/r2/s3/${encodeURIComponent(deployed.bucket.bucketName)}/`;
      expect(putUrl.startsWith(prefix)).toBe(true);
      expect(getUrl.startsWith(prefix)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
      "local",
    ],
    timeout: 120_000,
  },
);

/**
 * Async (non-Effect) Workers get the same per-mode wiring through
 * `Cloudflare.R2.S3Credentials` on `env`: in dev it resolves to the Worker's
 * local S3 endpoint and local credentials, and `aws4fetch` presigns against
 * it.
 */
test.provider(
  "async Worker presigns with S3Credentials against a locally-emulated bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          // The declaration form, as in async Worker modules
          const Bucket = Cloudflare.R2.Bucket("PresignAsyncBucket", {
            forceDestroy: true,
          });
          const worker = yield* Cloudflare.Worker("PresignAsyncWorker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/presign/async-worker.ts",
            ),
            env: {
              BUCKET: Bucket,
              BUCKET_S3: Cloudflare.R2.S3Credentials(Bucket, {
                access: "read-write",
              }),
            },
          });
          const bucket = yield* Bucket;
          return { bucket, worker };
        }),
      );

      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const { putUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/async.txt",
      );
      expect(
        putUrl.startsWith(`${deployed.worker.url}/cdn-cgi/local/r2/s3/`),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
      "local",
    ],
    timeout: 120_000,
  },
);

/**
 * `Alchemy.remote()` keeps the bucket on real Cloudflare during dev: the
 * presign binding mints a scoped API token and signs URLs for R2's S3
 * endpoint, the upload lands in the real bucket (verified out-of-band), and
 * destroy removes it.
 */
test.provider(
  "Alchemy.remote() bucket presigns against real R2 in dev",
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

      expect(deployed.bucket.bucketName).not.toMatch(/^dev:/);

      const { putUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/remote.txt",
      );
      expect(new URL(putUrl).hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);

      // Out-of-band: the upload is in the real bucket
      const { accountId } = yield* yield* CloudflareEnvironment;
      const object = yield* r2.getObject({
        accountId,
        bucketName: deployed.bucket.bucketName,
        objectName: "uploads/remote.txt",
      });
      const text = yield* object.body.pipe(Stream.decodeText, Stream.mkString);
      expect(text).toBe("uploaded via presigned url");

      yield* stack.destroy();

      const gone = yield* r2
        .getBucket({ accountId, bucketName: deployed.bucket.bucketName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:r2",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 180_000,
  },
);
