import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as lf from "@distilled.cloud/aws/lakeformation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const describeResource = (resourceArn: string) =>
  lf.describeResource({ ResourceArn: resourceArn }).pipe(
    Effect.map((r) => r.ResourceInfo),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider(
  "register, update, deregister an S3 location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create — register a bucket with the service-linked role
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("LfData", {});
          const location = yield* AWS.LakeFormation.Resource("LfLocation", {
            resourceArn: bucket.bucketArn,
          });
          return { bucket, location };
        }),
      );

      expect(created.location.resourceArn).toEqual(created.bucket.bucketArn);
      expect(created.location.roleArn).toContain(
        "AWSServiceRoleForLakeFormationDataAccess",
      );

      // out-of-band verification
      const observed = yield* describeResource(created.location.resourceArn);
      expect(observed).toBeDefined();
      expect(observed?.RoleArn).toEqual(created.location.roleArn);
      expect(observed?.HybridAccessEnabled).toEqual(false);

      // update — enable hybrid access mode
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("LfData", {});
          const location = yield* AWS.LakeFormation.Resource("LfLocation", {
            resourceArn: bucket.bucketArn,
            hybridAccessEnabled: true,
          });
          return { bucket, location };
        }),
      );

      expect(updated.location.resourceArn).toEqual(
        created.location.resourceArn,
      );
      expect(updated.location.hybridAccessEnabled).toEqual(true);
      const reobserved = yield* describeResource(created.location.resourceArn);
      expect(reobserved?.HybridAccessEnabled).toEqual(true);

      // delete
      yield* stack.destroy();
      const gone = yield* describeResource(created.location.resourceArn);
      expect(gone).toBeUndefined();
    }),
  { timeout: 180_000 },
);
