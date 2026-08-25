import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as datasync from "@distilled.cloud/aws/datasync";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const dsTags = (tags: readonly datasync.TagListEntry[] | undefined) =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

// DataSync surfaces a deleted location as the typed LocationNotFound (patched
// from InvalidRequestException + "…is not found").
const waitUntilLocationGone = (locationArn: string) =>
  datasync.describeLocationS3({ LocationArn: locationArn }).pipe(
    Effect.as(false),
    Effect.catchTag("LocationNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("1 seconds"),
      until: (gone) => gone,
      times: 20,
    }),
  );

const trustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "datasync.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider(
  "typed LocationNotFound on a nonexistent S3 location",
  () =>
    Effect.gen(function* () {
      const result = yield* datasync
        .describeLocationS3({
          LocationArn:
            "arn:aws:datasync:us-west-2:391965393224:location/loc-00000000000000000",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const err = result.failure as { _tag: string };
        expect(err._tag).toBe("LocationNotFound");
      }
    }),
  { timeout: 60_000 },
);

test.provider(
  "create, update tags, list, delete an S3 location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // --- create: bucket + access role + location ---
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("DsBucket", {
            forceDestroy: true,
          });
          const role = yield* AWS.IAM.Role("DsRole", {
            assumeRolePolicyDocument: trustPolicy,
            inlinePolicies: {
              DataSyncS3: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "s3:GetBucketLocation",
                      "s3:ListBucket",
                      "s3:ListBucketMultipartUploads",
                    ],
                    Resource: [bucket.bucketArn],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "s3:AbortMultipartUpload",
                      "s3:DeleteObject",
                      "s3:GetObject",
                      "s3:ListMultipartUploadParts",
                      "s3:PutObject",
                    ],
                    Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                  },
                ],
              },
            },
          });
          const location = yield* AWS.DataSync.LocationS3("Loc", {
            s3BucketArn: bucket.bucketArn,
            bucketAccessRoleArn: role.roleArn,
            subdirectory: "/data",
            tags: { purpose: "alchemy-datasync-test" },
          });
          return { location };
        }),
      );
      expect(created.location.locationArn).toContain(":location/loc-");
      expect(created.location.locationUri).toContain("s3://");
      expect(created.location.locationUri).toContain("/data");
      const arn = created.location.locationArn;

      const observed = yield* datasync.describeLocationS3({ LocationArn: arn });
      expect(observed.S3Config?.BucketAccessRoleArn).toContain(":role/");

      const tags = dsTags(
        (yield* datasync.listTagsForResource({ ResourceArn: arn })).Tags,
      );
      expect(tags.purpose).toBe("alchemy-datasync-test");
      expect(tags["alchemy::id"]).toBe("Loc");

      // --- list: the S3 location is enumerable ---
      const listed = yield* datasync.listLocations({});
      expect((listed.Locations ?? []).some((l) => l.LocationArn === arn)).toBe(
        true,
      );

      // --- update: change tags in place (location itself is immutable) ---
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("DsBucket", {
            forceDestroy: true,
          });
          const role = yield* AWS.IAM.Role("DsRole", {
            assumeRolePolicyDocument: trustPolicy,
            inlinePolicies: {
              DataSyncS3: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["s3:GetBucketLocation", "s3:ListBucket"],
                    Resource: [bucket.bucketArn],
                  },
                ],
              },
            },
          });
          const location = yield* AWS.DataSync.LocationS3("Loc", {
            s3BucketArn: bucket.bucketArn,
            bucketAccessRoleArn: role.roleArn,
            subdirectory: "/data",
            tags: { purpose: "alchemy-datasync-test", stage: "prod" },
          });
          return { location };
        }),
      );
      // immutable identity is preserved across a tag-only update
      expect(updated.location.locationArn).toBe(arn);
      const tags2 = dsTags(
        (yield* datasync.listTagsForResource({ ResourceArn: arn })).Tags,
      );
      expect(tags2.stage).toBe("prod");

      // --- delete ---
      yield* stack.destroy();
      const gone = yield* waitUntilLocationGone(arn);
      expect(gone).toBe(true);
    }),
  { timeout: 240_000 },
);
