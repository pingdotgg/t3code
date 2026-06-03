import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_R2_DOMAIN_ZONE_NAME ?? "alchemy-test-2.us";
const suffix = process.env.PULL_REQUEST ?? process.env.USER;
// A custom-domain hostname maps one-to-one to a bucket at the Cloudflare zone
// level, so it is a *global* resource. These suites run concurrently
// (`sequence.concurrent`), so every test must claim a hostname no other test
// uses — otherwise the tests race to attach the same hostname to different
// buckets and lose with `Conflict: Domain already in use`.
const domain = zoneName
  ? `alchemy-r2-test-single-${suffix}.${zoneName}`
  : undefined;
const domain2 = zoneName
  ? `alchemy-r2-test-multi-a-${suffix}.${zoneName}`
  : undefined;
const domain3 = zoneName
  ? `alchemy-r2-test-multi-b-${suffix}.${zoneName}`
  : undefined;

test.provider("creates, updates, and deletes a bucket custom domain", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DomainBucket", {
          domains: [{ name: domain! }],
        });
      }),
    );

    expect(bucket.domains).toHaveLength(1);
    expect(bucket.domains[0]?.domain).toEqual(domain);
    expect(bucket.domains[0]?.enabled).toEqual(true);

    const actual = yield* r2.getBucketDomainCustom({
      accountId,
      bucketName: bucket.bucketName,
      domain: domain!,
      jurisdiction: bucket.jurisdiction,
    });
    expect(actual.domain).toEqual(domain);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DomainBucket", {
          domains: [{ name: domain!, enabled: false }],
        });
      }),
    );

    expect(updated.domains[0]?.enabled).toEqual(false);

    yield* stack.destroy();

    const deleted = yield* r2
      .getBucketDomainCustom({
        accountId,
        bucketName: bucket.bucketName,
        domain: domain!,
        jurisdiction: bucket.jurisdiction,
      })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("DomainNotFound", () => Effect.succeed(true)),
        Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
      );
    expect(deleted).toEqual(true);

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider(
  "creates, updates, and deletes a bucket with multiple custom domains",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("MultiDomainBucket", {
            domains: [{ name: domain2! }, { name: domain3! }],
          });
        }),
      );

      expect(bucket.domains).toHaveLength(2);
      const domainNames = bucket.domains.map((d) => d.domain).sort();
      expect(domainNames).toEqual([domain2, domain3].sort());
      expect(bucket.domains.every((d) => d.enabled)).toEqual(true);

      for (const name of [domain2!, domain3!]) {
        const actual = yield* r2.getBucketDomainCustom({
          accountId,
          bucketName: bucket.bucketName,
          domain: name,
          jurisdiction: bucket.jurisdiction,
        });
        expect(actual.domain).toEqual(name);
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("MultiDomainBucket", {
            domains: [{ name: domain3!, enabled: false }, { name: domain2! }],
          });
        }),
      );

      const updatedByName = Object.fromEntries(
        updated.domains.map((d) => [d.domain, d]),
      );
      expect(updatedByName[domain3!]?.enabled).toEqual(false);
      expect(updatedByName[domain2!]?.enabled).toEqual(true);

      const removed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("MultiDomainBucket", {
            domains: [{ name: domain2! }],
          });
        }),
      );

      expect(removed.domains).toHaveLength(1);
      expect(removed.domains[0]?.domain).toEqual(domain2);

      const firstRemoved = yield* r2
        .getBucketDomainCustom({
          accountId,
          bucketName: bucket.bucketName,
          domain: domain3!,
          jurisdiction: bucket.jurisdiction,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("DomainNotFound", () => Effect.succeed(true)),
        );
      expect(firstRemoved).toEqual(true);

      yield* stack.destroy();

      for (const name of [domain2!, domain3!]) {
        const deleted = yield* r2
          .getBucketDomainCustom({
            accountId,
            bucketName: bucket.bucketName,
            domain: name,
            jurisdiction: bucket.jurisdiction,
          })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("DomainNotFound", () => Effect.succeed(true)),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
          );
        expect(deleted).toEqual(true);
      }

      yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
    }).pipe(logLevel),
);

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
