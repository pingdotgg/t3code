import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Enabling Sippy requires real external-cloud credentials: an AWS S3 (or
// GCS) source bucket with read credentials, plus an R2 API token with
// write access for the destination. The testing account ships neither, so
// the full lifecycle test below is gated behind env-supplied credentials.
// Without them, `putBucketSippy` fails with the typed
// `InvalidUpstreamCredentials` (code 10063) — asserted in the ungated test.
const sippyCreds =
  !!process.env.TEST_SIPPY_AWS_BUCKET &&
  !!process.env.TEST_SIPPY_AWS_REGION &&
  !!process.env.TEST_SIPPY_AWS_ACCESS_KEY_ID &&
  !!process.env.TEST_SIPPY_AWS_SECRET_ACCESS_KEY &&
  !!process.env.TEST_SIPPY_R2_ACCESS_KEY_ID &&
  !!process.env.TEST_SIPPY_R2_SECRET_ACCESS_KEY;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getSippy = (accountId: string, bucketName: string) =>
  r2.getBucketSippy({ accountId, bucketName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const program = (opts: { sippy: boolean }) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("SippyBucket");
    const sippy = opts.sippy
      ? yield* Cloudflare.R2.BucketSippy("Sippy", {
          bucketName: bucket.bucketName,
          source: {
            provider: "aws",
            bucket: process.env.TEST_SIPPY_AWS_BUCKET!,
            region: process.env.TEST_SIPPY_AWS_REGION!,
            accessKeyId: Redacted.make(
              process.env.TEST_SIPPY_AWS_ACCESS_KEY_ID!,
            ),
            secretAccessKey: Redacted.make(
              process.env.TEST_SIPPY_AWS_SECRET_ACCESS_KEY!,
            ),
          },
          destination: {
            accessKeyId: Redacted.make(
              process.env.TEST_SIPPY_R2_ACCESS_KEY_ID!,
            ),
            secretAccessKey: Redacted.make(
              process.env.TEST_SIPPY_R2_SECRET_ACCESS_KEY!,
            ),
          },
        })
      : undefined;
    return { bucket, sippy };
  });

// Ungated — exercises everything Sippy exposes without external creds:
// the disabled baseline read, idempotent disable, and the typed failure
// tags the provider's lifecycle operations rely on.
test.provider(
  "reads the disabled baseline and surfaces typed errors without external creds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { bucket } = yield* stack.deploy(program({ sippy: false }));

      // A bucket with Sippy never configured reads back `enabled: false` —
      // the provider's `read` maps this to "resource absent".
      const baseline = yield* getSippy(accountId, bucket.bucketName);
      expect(baseline.enabled).toEqual(false);

      // Disabling Sippy when it was never enabled succeeds — the
      // provider's `delete` is idempotent by construction.
      const disabled = yield* r2.deleteBucketSippy({
        accountId,
        bucketName: bucket.bucketName,
      });
      expect(disabled.enabled).toEqual(false);

      // Enabling with bogus upstream credentials fails with the typed
      // `InvalidUpstreamCredentials` tag (code 10063) — the error a
      // failed reconcile propagates.
      const putError = yield* r2
        .putBucketSippy({
          accountId,
          bucketName: bucket.bucketName,
          source: {
            provider: "aws",
            bucket: "alchemy-nonexistent-source",
            region: "us-east-1",
            accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
            secretAccessKey: "fakefakefakefakefakefakefakefakefakefake",
          },
          destination: {
            provider: "r2",
            accessKeyId: "deadbeefdeadbeefdeadbeefdeadbeef",
            secretAccessKey:
              "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          },
        })
        .pipe(Effect.flip);
      expect(putError._tag).toEqual("InvalidUpstreamCredentials");

      yield* stack.destroy();

      // Once the bucket is gone, the Sippy endpoints report the typed
      // `NoSuchBucket` (code 10006) — what `read` maps to undefined and
      // `delete` swallows.
      const goneError = yield* getSippy(accountId, bucket.bucketName).pipe(
        Effect.flip,
      );
      expect(goneError._tag).toEqual("NoSuchBucket");

      // Destroy again — engine-level delete must be idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// list() — parent fan-out singleton. Ungated path: without external creds
// no bucket has Sippy enabled, so the enumeration is a well-typed array that
// must NOT contain the freshly-deployed (Sippy-disabled) bucket. This still
// exercises the bucket fan-out + per-item typed skip end-to-end.
test.provider(
  "list enumerates buckets that have Sippy enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { bucket } = yield* stack.deploy(program({ sippy: false }));

      const provider = yield* Provider.findProvider(Cloudflare.R2.BucketSippy);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Sippy was never enabled on this bucket, so it must be absent and
      // every returned item must report `enabled: true` (matching `read`).
      expect(all.some((s) => s.bucketName === bucket.bucketName)).toBe(false);
      expect(all.every((s) => s.enabled === true)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Gated list() — with real creds the enabled bucket must appear in the
// account-wide enumeration.
test.provider.skipIf(!sippyCreds)(
  "list includes a bucket with Sippy enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ sippy: true }));

      const provider = yield* Provider.findProvider(Cloudflare.R2.BucketSippy);
      const all = yield* provider.list();

      expect(
        all.some(
          (s) => s.bucketName === created.bucket.bucketName && s.enabled,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// Full lifecycle — requires env-supplied AWS source + R2 destination
// credentials (see `sippyCreds` above for the exact variables).
test.provider.skipIf(!sippyCreds)(
  "enable, no-op redeploy, disable on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(program({ sippy: true }));
      expect(created.sippy).toBeDefined();
      expect(created.sippy!.enabled).toEqual(true);
      expect(created.sippy!.accountId).toEqual(accountId);
      expect(created.sippy!.bucketName).toEqual(created.bucket.bucketName);
      expect(created.sippy!.jurisdiction).toEqual("default");
      expect(created.sippy!.source.provider).toEqual("aws");
      expect(created.sippy!.source.bucket).toEqual(
        process.env.TEST_SIPPY_AWS_BUCKET,
      );
      expect(created.sippy!.destination.provider).toEqual("r2");

      // Out-of-band — Sippy is live on the bucket.
      const live = yield* getSippy(accountId, created.bucket.bucketName);
      expect(live.enabled).toEqual(true);
      expect(live.source?.bucket).toEqual(process.env.TEST_SIPPY_AWS_BUCKET);

      // Redeploying identical props re-PUTs the same configuration — a
      // converging no-op (the PUT is a full upsert).
      const noop = yield* stack.deploy(program({ sippy: true }));
      expect(noop.sippy!.enabled).toEqual(true);
      expect(noop.sippy!.bucketName).toEqual(created.bucket.bucketName);

      // Removing the resource disables Sippy but keeps the bucket (and
      // any already-migrated objects).
      const removed = yield* stack.deploy(program({ sippy: false }));
      expect(removed.bucket.bucketName).toEqual(created.bucket.bucketName);
      const disabled = yield* getSippy(accountId, removed.bucket.bucketName);
      expect(disabled.enabled).toEqual(false);

      yield* stack.destroy();

      const goneError = yield* getSippy(
        accountId,
        created.bucket.bucketName,
      ).pipe(Effect.flip);
      expect(goneError._tag).toEqual("NoSuchBucket");
    }).pipe(logLevel),
  { timeout: 300_000 },
);
