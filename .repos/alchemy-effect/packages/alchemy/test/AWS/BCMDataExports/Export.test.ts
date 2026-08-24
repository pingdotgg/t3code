import * as AWS from "@/AWS";
import { Export } from "@/AWS/BCMDataExports/Export.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "getExport on a nonexistent export ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        bcm.getExport({
          ExportArn: `arn:aws:bcm-data-exports:us-east-1:${accountId}:export/alchemy-nonexistent-probe/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const bucketName = "alchemy-test-bcm-export-dest";
const exportName = "alchemy-test-bcm-export";
const renamedExportName = "alchemy-test-bcm-export-renamed";

const queryStatement =
  "SELECT identity_line_item_id, identity_time_interval, line_item_unblended_cost FROM COST_AND_USAGE_REPORT";
const tableConfigurations = {
  COST_AND_USAGE_REPORT: {
    TIME_GRANULARITY: "HOURLY",
    INCLUDE_RESOURCES: "FALSE",
    INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY: "FALSE",
    INCLUDE_SPLIT_COST_ALLOCATION_DATA: "FALSE",
  },
};

// The destination bucket must let the Data Exports service principals write
// to it and read its policy.
const destinationBucket = (accountId: string) =>
  Bucket("ExportDest", {
    bucketName,
    forceDestroy: true,
    policy: [
      {
        Sid: "EnableAWSDataExportsToWriteToS3AndCheckPolicy",
        Effect: "Allow",
        Principal: {
          Service: [
            "billingreports.amazonaws.com",
            "bcm-data-exports.amazonaws.com",
          ],
        },
        Action: ["s3:PutObject", "s3:GetBucketPolicy"],
        Resource: [
          `arn:aws:s3:::${bucketName}`,
          `arn:aws:s3:::${bucketName}/*`,
        ],
        Condition: {
          StringLike: {
            "aws:SourceAccount": accountId,
            "aws:SourceArn": [
              `arn:aws:cur:us-east-1:${accountId}:definition/*`,
              `arn:aws:bcm-data-exports:us-east-1:${accountId}:export/*`,
            ],
          },
        },
      },
    ],
  });

const getExportByArn = (arn: string) =>
  bcm.getExport({ ExportArn: arn }).pipe(
    Effect.map((r) => r.Export),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

// Typed wait-until-gone: bounded, declarative.
const assertExportGone = (arn: string) =>
  Effect.gen(function* () {
    const live = yield* getExportByArn(arn);
    if (live !== undefined) {
      return yield* Effect.fail(
        new Error(`export '${arn}' still exists after destroy`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "lifecycle: create CUR 2.0 export, update in place, replace on rename, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;

      // CREATE — bucket (with Data Exports write policy) + export.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* destinationBucket(accountId);
          const exp = yield* Export("CurExport", {
            exportName,
            description: "alchemy bcm-data-exports test",
            dataQuery: { queryStatement, tableConfigurations },
            s3Destination: {
              s3Bucket: bucket.bucketName,
              s3Prefix: "cur2",
              s3Region: region,
            },
            tags: { fixture: "bcm-data-exports" },
          });
          return { exportArn: exp.exportArn, exportName: exp.exportName };
        }),
      );

      expect(deployed.exportName).toBe(exportName);
      expect(deployed.exportArn).toContain(":bcm-data-exports:");
      expect(deployed.exportArn).toContain(`:export/`);

      // Out-of-band verification via distilled.
      const created = yield* getExportByArn(deployed.exportArn);
      expect(created?.Name).toBe(exportName);
      expect(created?.Description).toBe("alchemy bcm-data-exports test");
      expect(created?.DataQuery.QueryStatement).toBe(queryStatement);
      expect(created?.DestinationConfigurations.S3Destination.S3Bucket).toBe(
        bucketName,
      );
      expect(created?.DestinationConfigurations.S3Destination.S3Prefix).toBe(
        "cur2",
      );
      expect(created?.RefreshCadence.Frequency).toBe("SYNCHRONOUS");

      // Tags: internal branding + user tag attached at create.
      const tags = yield* bcm
        .listTagsForResource({ ResourceArn: deployed.exportArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.ResourceTags ?? []).map((t) => [t.Key, t.Value]),
            ),
          ),
        );
      expect(tags.fixture).toBe("bcm-data-exports");
      expect(tags["alchemy::id"]).toBe("CurExport");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Export);
      const all = yield* provider.list();
      expect(all.some((e) => e.exportName === exportName)).toBe(true);

      // UPDATE in place — new description + prefix, tag change. Same ARN.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* destinationBucket(accountId);
          const exp = yield* Export("CurExport", {
            exportName,
            description: "alchemy bcm-data-exports test (updated)",
            dataQuery: { queryStatement, tableConfigurations },
            s3Destination: {
              s3Bucket: bucket.bucketName,
              s3Prefix: "cur2-updated",
              s3Region: region,
            },
            tags: { fixture: "bcm-data-exports", phase: "two" },
          });
          return { exportArn: exp.exportArn };
        }),
      );
      expect(updated.exportArn).toBe(deployed.exportArn);

      const afterUpdate = yield* getExportByArn(deployed.exportArn);
      expect(afterUpdate?.Description).toBe(
        "alchemy bcm-data-exports test (updated)",
      );
      expect(
        afterUpdate?.DestinationConfigurations.S3Destination.S3Prefix,
      ).toBe("cur2-updated");

      const tagsAfterUpdate = yield* bcm
        .listTagsForResource({ ResourceArn: deployed.exportArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.ResourceTags ?? []).map((t) => [t.Key, t.Value]),
            ),
          ),
        );
      expect(tagsAfterUpdate.phase).toBe("two");

      // REPLACE — renaming the export replaces it (new ARN, old one gone).
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* destinationBucket(accountId);
          const exp = yield* Export("CurExport", {
            exportName: renamedExportName,
            description: "alchemy bcm-data-exports test (updated)",
            dataQuery: { queryStatement, tableConfigurations },
            s3Destination: {
              s3Bucket: bucket.bucketName,
              s3Prefix: "cur2-updated",
              s3Region: region,
            },
            tags: { fixture: "bcm-data-exports", phase: "two" },
          });
          return { exportArn: exp.exportArn, exportName: exp.exportName };
        }),
      );
      expect(renamed.exportName).toBe(renamedExportName);
      expect(renamed.exportArn).not.toBe(deployed.exportArn);
      yield* assertExportGone(deployed.exportArn);

      // DESTROY — export and bucket removed; verify out-of-band.
      yield* stack.destroy();
      yield* assertExportGone(renamed.exportArn);
    }),
  { timeout: 300_000 },
);
