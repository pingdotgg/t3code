import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { MultiRegionAccessPoint } from "@/AWS/S3Control";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const ACCOUNT_ID = "391965393224";

// Multi-Region Access Point control-plane requests route through us-west-2.
const findMrap = (name: string) =>
  s3control
    .getMultiRegionAccessPoint({ AccountId: ACCOUNT_ID, Name: name })
    .pipe(
      Effect.map((r) => r.AccessPoint),
      Effect.catchTag("NoSuchMultiRegionAccessPoint", () =>
        Effect.succeed(undefined),
      ),
      Effect.provideService(Region, Effect.succeed("us-west-2")),
    );

test.provider(
  "typed NoSuchMultiRegionAccessPoint tag on a nonexistent access point",
  () =>
    Effect.gen(function* () {
      const result = yield* s3control
        .getMultiRegionAccessPoint({
          AccountId: ACCOUNT_ID,
          Name: "alchemy-does-not-exist-xyz",
        })
        .pipe(
          Effect.map(() => "found" as const),
          // proves the patched typed union — no cast, no catch-all
          Effect.catchTag("NoSuchMultiRegionAccessPoint", () =>
            Effect.succeed("missing" as const),
          ),
          Effect.provideService(Region, Effect.succeed("us-west-2")),
        );
      expect(result).toBe("missing");
    }),
  { timeout: 60_000 },
);

// Multi-Region Access Point provisioning is asynchronous and can consume the
// entire 240s suite ceiling, so the full lifecycle remains explicitly gated.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create and delete multi-region access point (slow, gated)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("MrapBucket", { forceDestroy: true });
          const mrap = yield* MultiRegionAccessPoint("TestMrap", {
            regions: [{ bucket: bucket.bucketName }],
          });
          return { bucket, mrap };
        }),
      );

      expect(deployed.mrap.multiRegionAccessPointName).toBeDefined();
      expect(deployed.mrap.status).toBe("READY");
      expect(deployed.mrap.alias).toBeDefined();
      expect(deployed.mrap.multiRegionAccessPointArn).toBe(
        `arn:aws:s3::${ACCOUNT_ID}:accesspoint/${deployed.mrap.alias}`,
      );

      // out-of-band verification via distilled
      const live = yield* findMrap(deployed.mrap.multiRegionAccessPointName);
      expect(live?.Status).toBe("READY");
      expect(live?.Regions?.[0]?.Bucket).toBe(deployed.bucket.bucketName);

      yield* stack.destroy();

      const afterDestroy = yield* findMrap(
        deployed.mrap.multiRegionAccessPointName,
      );
      expect(afterDestroy).toBeUndefined();
    }),
  { timeout: 240_000 },
);
