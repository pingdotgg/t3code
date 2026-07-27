import * as AWS from "@/AWS";
import { StorageLensConfiguration } from "@/AWS/S3Control";
import * as Test from "@/Test/Alchemy";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const ACCOUNT_ID = "391965393224";

const findConfiguration = (configId: string) =>
  s3control
    .getStorageLensConfiguration({ AccountId: ACCOUNT_ID, ConfigId: configId })
    .pipe(
      Effect.map((r) => r.StorageLensConfiguration),
      Effect.catchTag("NoSuchConfiguration", () => Effect.succeed(undefined)),
    );

class ConfigurationStillExists extends Data.TaggedError(
  "ConfigurationStillExists",
)<{ readonly configId: string }> {}

const assertConfigurationDeleted = (configId: string) =>
  findConfiguration(configId).pipe(
    Effect.flatMap((cfg) =>
      cfg === undefined
        ? Effect.void
        : Effect.fail(new ConfigurationStillExists({ configId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ConfigurationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "typed NoSuchConfiguration tag on a nonexistent configuration",
  () =>
    Effect.gen(function* () {
      const result = yield* s3control
        .getStorageLensConfiguration({
          AccountId: ACCOUNT_ID,
          ConfigId: "alchemy-does-not-exist-xyz",
        })
        .pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("NoSuchConfiguration", () =>
            Effect.succeed("missing" as const),
          ),
        );
      expect(result).toBe("missing");
    }),
  { timeout: 60_000 },
);

test.provider(
  "create, update, delete storage lens configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const lens = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StorageLensConfiguration("TestLens", {
            tags: { Environment: "test" },
          });
        }),
      );

      expect(lens.configId).toBeDefined();
      expect(lens.storageLensArn).toContain(":storage-lens/");

      // out-of-band verification via distilled
      const live = yield* findConfiguration(lens.configId);
      expect(live?.IsEnabled).toBe(true);
      expect(live?.AccountLevel).toBeDefined();

      const tags = yield* s3control
        .getStorageLensConfigurationTagging({
          AccountId: ACCOUNT_ID,
          ConfigId: lens.configId,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestLens");

      // update: disable the dashboard + enable activity metrics + retag
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StorageLensConfiguration("TestLens", {
            isEnabled: false,
            // account-level activity metrics require bucket-level activity
            // metrics to be enabled as well (MissingBucketLevelActivityMetrics)
            accountLevel: {
              ActivityMetrics: { IsEnabled: true },
              BucketLevel: { ActivityMetrics: { IsEnabled: true } },
            },
            tags: { Environment: "production" },
          });
        }),
      );
      expect(updated.configId).toBe(lens.configId);

      const updatedLive = yield* findConfiguration(lens.configId);
      expect(updatedLive?.IsEnabled).toBe(false);
      expect(updatedLive?.AccountLevel?.ActivityMetrics?.IsEnabled).toBe(true);

      const updatedTags = yield* s3control
        .getStorageLensConfigurationTagging({
          AccountId: ACCOUNT_ID,
          ConfigId: lens.configId,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.Environment).toBe("production");

      yield* stack.destroy();
      yield* assertConfigurationDeleted(lens.configId);
    }),
  { timeout: 120_000 },
);
