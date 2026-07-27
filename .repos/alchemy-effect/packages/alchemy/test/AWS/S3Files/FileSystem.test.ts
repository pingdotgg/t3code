import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as s3files from "@distilled.cloud/aws/s3files";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const tagRecord = (tags: readonly s3files.Tag[] | undefined) =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's observe/read/delete paths depend on. Runs
// in every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getFileSystem on a nonexistent file system fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        s3files.getFileSystem({ fileSystemId: "fs-0123456789abcdef0" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

// Ungated reachability probe: the account can enumerate file systems in the
// test region (proves endpoint + auth + response decoding).
test.provider(
  "listFileSystems succeeds",
  () =>
    Effect.gen(function* () {
      const listed = yield* s3files.listFileSystems({ maxResults: 5 });
      expect(Array.isArray(listed.fileSystems)).toBe(true);
    }),
  { timeout: 60_000 },
);

// S3 Files runs on EFS infrastructure — the file system role is assumed by
// the elasticfilesystem service principal, not an s3files one.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html
const trustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "elasticfilesystem.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const waitUntilFileSystemGone = (fileSystemId: string) =>
  s3files.getFileSystem({ fileSystemId }).pipe(
    Effect.as(false),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("5 seconds"),
      until: (gone) => gone,
      times: 24,
    }),
  );

test.provider(
  "create file system + access point, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          // S3 Files requires versioning on the source bucket.
          const bucket = yield* AWS.S3.Bucket("FilesBucket", {
            forceDestroy: true,
            versioning: "Enabled",
          });
          const role = yield* AWS.IAM.Role("FilesRole", {
            assumeRolePolicyDocument: trustPolicy,
            inlinePolicies: {
              S3FilesBucketAccess: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["s3:ListBucket", "s3:ListBucketVersions"],
                    Resource: [bucket.bucketArn],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "s3:GetObject*",
                      "s3:PutObject*",
                      "s3:DeleteObject*",
                      "s3:List*",
                      "s3:AbortMultipartUpload",
                    ],
                    Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "events:DeleteRule",
                      "events:DisableRule",
                      "events:EnableRule",
                      "events:PutRule",
                      "events:PutTargets",
                      "events:RemoveTargets",
                    ],
                    Resource: [
                      "arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*",
                    ],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "events:DescribeRule",
                      "events:ListRuleNamesByTarget",
                      "events:ListRules",
                      "events:ListTargetsByRule",
                    ],
                    Resource: ["arn:aws:events:*:*:rule/*"],
                  },
                ],
              },
            },
          });
          const fileSystem = yield* AWS.S3Files.FileSystem("Files", {
            bucket: bucket.bucketArn,
            roleArn: role.roleArn,
            tags: { fixture: "s3files-filesystem" },
          });
          const accessPoint = yield* AWS.S3Files.AccessPoint("Access", {
            fileSystemId: fileSystem.fileSystemId,
            posixUser: { uid: 1000, gid: 1000 },
            rootDirectory: {
              path: "/app",
              creationPermissions: {
                ownerUid: 1000,
                ownerGid: 1000,
                permissions: "0755",
              },
            },
          });
          return { fileSystem, accessPoint };
        }),
      );

      expect(created.fileSystem.fileSystemId).toContain("fs-");
      expect(created.fileSystem.fileSystemArn).toContain(":file-system/");
      expect(created.fileSystem.status).toBe("available");
      expect(created.accessPoint.fileSystemId).toBe(
        created.fileSystem.fileSystemId,
      );
      expect(created.accessPoint.status).toBe("available");

      // Out-of-band verification via distilled.
      const observed = yield* s3files.getFileSystem({
        fileSystemId: created.fileSystem.fileSystemId,
      });
      expect(observed.status).toBe("available");
      expect(observed.bucket).toBe(created.fileSystem.bucket);
      const tags = tagRecord(observed.tags);
      expect(tags.fixture).toBe("s3files-filesystem");
      expect(tags["alchemy::id"]).toBe("Files");

      const observedAp = yield* s3files.getAccessPoint({
        accessPointId: created.accessPoint.accessPointId,
      });
      expect(observedAp.posixUser?.uid).toBe(1000);
      expect(observedAp.rootDirectory?.path).toBe("/app");

      // Destroy and verify the file system is gone out-of-band.
      yield* stack.destroy();
      const gone = yield* waitUntilFileSystemGone(
        created.fileSystem.fileSystemId,
      );
      expect(gone).toBe(true);
    }),
  { timeout: 600_000 },
);
