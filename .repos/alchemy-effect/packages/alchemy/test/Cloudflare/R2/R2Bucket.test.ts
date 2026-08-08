import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "list enumerates the deployed R2 bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("ListResource", {
            name: "alchemy-r2bucket-list-test",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.R2.Bucket);
      const all = yield* provider.list();

      const found = all.find((b) => b.bucketName === bucket.bucketName);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(bucket.accountId);
      expect(found?.jurisdiction).toEqual(bucket.jurisdiction);
      expect(found?.storageClass).toEqual(bucket.storageClass);

      yield* stack.destroy();
    }).pipe(logLevel),
  // `list()` is genuinely O(account buckets): it enumerates every R2 bucket
  // across all three jurisdictions and hydrates each (custom domains +
  // lifecycle), all with bounded per-item retries (no unbounded hang). The
  // provider no longer wastes the consistency-retry budget on buckets a
  // parallel suite is concurrently deleting, but a heavily-populated shared
  // account can still take a while — keep a modest margin over the 120s
  // default for the genuine enumeration cost.
  { timeout: 180_000 },
);
