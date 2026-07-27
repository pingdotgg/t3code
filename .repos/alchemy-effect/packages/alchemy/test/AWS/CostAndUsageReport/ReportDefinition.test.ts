import * as AWS from "@/AWS";
import { ReportDefinition } from "@/AWS/CostAndUsageReport";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// The CUR control plane is only hosted in us-east-1 — pin every out-of-band
// distilled call there, exactly like the provider does.
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

const findReport = (name: string) =>
  pin(cur.describeReportDefinitions.pages({}).pipe(Stream.runCollect)).pipe(
    Effect.map((pages) =>
      Array.from(pages)
        .flatMap((page) => page.ReportDefinitions ?? [])
        .find((r) => r.ReportName === name),
    ),
  );

const assertReportGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* findReport(name);
    if (found) {
      return yield* Effect.fail(
        new Error(`report definition '${name}' still exists`),
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

// Ungated probe: proves auth + response schema against the live us-east-1
// CUR endpoint on every CI pass at near-zero cost.
test.provider(
  "describeReportDefinitions lists report definitions (auth + schema probe)",
  () =>
    Effect.gen(function* () {
      const response = yield* pin(cur.describeReportDefinitions({}));
      expect(Array.isArray(response.ReportDefinitions ?? [])).toBe(true);
    }),
);

const REPORT_NAME = "alchemy-test-cur-report";
const REPLACED_REPORT_NAME = "alchemy-test-cur-report-v2";
const BUCKET_NAME = "alchemy-test-cur-reports";

test.provider(
  "create, update, replace, delete report definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* AWSEnvironment.current;

      // The CUR bucket policy AWS requires before it will deliver reports.
      const curBucketPolicy = [
        {
          Effect: "Allow" as const,
          Principal: { Service: "billingreports.amazonaws.com" },
          Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
          Resource: `arn:aws:s3:::${BUCKET_NAME}`,
          Condition: {
            StringEquals: {
              "aws:SourceAccount": accountId,
              "aws:SourceArn": `arn:aws:cur:us-east-1:${accountId}:definition/*`,
            },
          },
        },
        {
          Effect: "Allow" as const,
          Principal: { Service: "billingreports.amazonaws.com" },
          Action: ["s3:PutObject"],
          Resource: `arn:aws:s3:::${BUCKET_NAME}/*`,
          Condition: {
            StringEquals: {
              "aws:SourceAccount": accountId,
              "aws:SourceArn": `arn:aws:cur:us-east-1:${accountId}:definition/*`,
            },
          },
        },
      ];

      const program = (opts: {
        reportName: string;
        timeUnit: "DAILY" | "HOURLY";
        compression: "GZIP" | "ZIP";
      }) =>
        Effect.gen(function* () {
          const bucket = yield* Bucket("ReportBucket", {
            bucketName: BUCKET_NAME,
            forceDestroy: true,
            policy: curBucketPolicy,
          });
          const report = yield* ReportDefinition("Report", {
            reportName: opts.reportName,
            timeUnit: opts.timeUnit,
            format: "textORcsv",
            compression: opts.compression,
            additionalSchemaElements: ["RESOURCES"],
            s3Bucket: bucket.bucketName,
            s3Prefix: "cur",
            s3Region: bucket.region,
            tags: { fixture: "cur-report" },
          });
          return { bucket, report };
        });

      // CREATE
      const created = yield* stack.deploy(
        program({
          reportName: REPORT_NAME,
          timeUnit: "DAILY",
          compression: "GZIP",
        }),
      );
      expect(created.report.reportName).toBe(REPORT_NAME);
      expect(created.report.reportArn).toBe(
        `arn:aws:cur:us-east-1:${accountId}:definition/${REPORT_NAME}`,
      );
      expect(created.report.s3Bucket).toBe(BUCKET_NAME);
      expect(created.report.s3Prefix).toBe("cur");
      expect(created.report.timeUnit).toBe("DAILY");

      // Out-of-band verification via distilled.
      const observed = yield* findReport(REPORT_NAME);
      expect(observed?.TimeUnit).toBe("DAILY");
      expect(observed?.Format).toBe("textORcsv");
      expect(observed?.Compression).toBe("GZIP");
      expect(observed?.S3Bucket).toBe(BUCKET_NAME);
      expect(observed?.AdditionalSchemaElements).toContain("RESOURCES");

      // Tags: user tag + alchemy internal tags.
      const tags = yield* pin(
        cur.listTagsForResource({ ReportName: REPORT_NAME }),
      );
      expect(tags.Tags).toContainEqual({ Key: "fixture", Value: "cur-report" });
      expect(tags.Tags?.some((t) => t.Key.startsWith("alchemy:"))).toBe(true);

      // Typed duplicate probe: a second putReportDefinition with the same
      // name must surface the typed DuplicateReportNameException tag.
      const duplicate = yield* Effect.flip(
        pin(
          cur.putReportDefinition({
            ReportDefinition: {
              ReportName: REPORT_NAME,
              TimeUnit: "DAILY",
              Format: "textORcsv",
              Compression: "GZIP",
              AdditionalSchemaElements: ["RESOURCES"],
              S3Bucket: BUCKET_NAME,
              S3Prefix: "cur",
              S3Region: observed!.S3Region,
            },
          }),
        ),
      );
      expect(duplicate._tag).toBe("DuplicateReportNameException");

      // UPDATE in place (timeUnit + compression via modifyReportDefinition).
      const updated = yield* stack.deploy(
        program({
          reportName: REPORT_NAME,
          timeUnit: "HOURLY",
          compression: "ZIP",
        }),
      );
      expect(updated.report.reportName).toBe(REPORT_NAME);
      const modified = yield* findReport(REPORT_NAME);
      expect(modified?.TimeUnit).toBe("HOURLY");
      expect(modified?.Compression).toBe("ZIP");

      // REPLACE on reportName change: new report created, old one deleted.
      const replaced = yield* stack.deploy(
        program({
          reportName: REPLACED_REPORT_NAME,
          timeUnit: "HOURLY",
          compression: "ZIP",
        }),
      );
      expect(replaced.report.reportName).toBe(REPLACED_REPORT_NAME);
      const replacement = yield* findReport(REPLACED_REPORT_NAME);
      expect(replacement?.TimeUnit).toBe("HOURLY");
      yield* assertReportGone(REPORT_NAME);

      // DELETE
      yield* stack.destroy();
      yield* assertReportGone(REPLACED_REPORT_NAME);
    }),
  { timeout: 240_000 },
);
