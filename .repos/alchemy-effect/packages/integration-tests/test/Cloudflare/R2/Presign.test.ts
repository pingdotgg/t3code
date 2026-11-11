import * as Cloudflare from "@alchemy.run/cloudflare";
import { liveEndpoint, s3CredentialsPolicy } from "@alchemy.run/cloudflare/R2/S3CredentialsBinding";
import { expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import PresignRemoteWorker, { PresignRemoteBucket } from "./fixtures/presign/remote-worker.ts";
import { presignRoundTrip } from "./fixtures/presign/roundtrip.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class OtherBucketNotReady extends Data.TaggedError("OtherBucketNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * Seed `key` in the other bucket through the Worker's native binding, then
 * presign a GET for it with the first bucket's S3 credentials and fetch it.
 * The token is bucket-scoped, so R2 must answer 403.
 */
const expectOtherBucketDenied = (workerUrl: string, otherBucket: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const okText = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(request).pipe(
        Effect.flatMap((res) =>
          res.text.pipe(
            Effect.flatMap((body) =>
              res.status === 200
                ? Effect.succeed(body)
                : Effect.fail(new OtherBucketNotReady({ status: res.status, body })),
            ),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
      );

    yield* okText(
      HttpClientRequest.post(`${workerUrl}/write-other?key=${encodeURIComponent(key)}`).pipe(
        HttpClientRequest.setBody(HttpBody.text("other bucket secret")),
      ),
    );
    const { url } = JSON.parse(
      yield* okText(
        HttpClientRequest.get(
          `${workerUrl}/presign-other-bucket?bucket=${encodeURIComponent(otherBucket)}&key=${encodeURIComponent(key)}`,
        ),
      ),
    ) as { url: string };
    expect(new URL(url).pathname.startsWith(`/${otherBucket}/`)).toBe(true);

    const res = yield* client.execute(HttpClientRequest.get(url));
    const body = yield* res.text;
    expect(body).not.toContain("other bucket secret");
    expect(res.status).toBe(403);
  });

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
        expect(parsed.pathname.startsWith(`/${deployed.bucket.bucketName}/`)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
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
          // A second bucket in the same account that the credentials must
          // NOT reach. The Worker binds it natively only to seed an object.
          const otherBucket = yield* Cloudflare.R2.Bucket("PresignAsyncOtherBucket", {
            forceDestroy: true,
          });
          const worker = yield* Cloudflare.Worker("PresignAsyncWorker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/presign/async-worker.ts"),
            env: {
              BUCKET: bucket,
              OTHER_BUCKET: otherBucket,
              BUCKET_S3: Cloudflare.R2.S3Credentials(bucket, {
                access: "read-write",
              }),
            },
          });
          return { bucket, otherBucket, worker };
        }),
      );

      const { putUrl } = yield* presignRoundTrip(
        deployed.worker.url!,
        "uploads/async deployed.txt",
      );
      expect(new URL(putUrl).hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);

      // The token behind the credentials is scoped to BUCKET: an object in
      // another bucket of the same account is not readable with them.
      const otherKey = "secret.txt";
      yield* expectOtherBucketDenied(
        deployed.worker.url!,
        deployed.otherBucket.bucketName,
        otherKey,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

// A jurisdictional bucket's token resource carries its jurisdiction; the live
// tests above only deploy `default`-jurisdiction buckets.
it(
  "S3Credentials scopes a jurisdictional bucket's token to that jurisdiction",
  () => {
    expect(s3CredentialsPolicy("acct", "uploads", "eu", "read").resources).toEqual({
      "com.cloudflare.edge.r2.bucket.acct_eu_uploads": "*",
    });
    expect(s3CredentialsPolicy("acct", "gov", "fedramp", "write").resources).toEqual({
      "com.cloudflare.edge.r2.bucket.acct_fedramp_gov": "*",
    });
    expect(s3CredentialsPolicy("acct", "records", "us", "read").resources).toEqual({
      "com.cloudflare.edge.r2.bucket.acct_us_records": "*",
    });
    expect(liveEndpoint("acct", "us")).toBe("https://acct.us.r2.cloudflarestorage.com");
  },
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:r2", "local"] },
);
