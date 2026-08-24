import * as CostAndUsageReport from "@/AWS/CostAndUsageReport";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic names — distinct from ReportDefinition.test.ts's fixtures so
// the two suites never collide.
export const REPORT_NAME = "alchemy-test-cur-bindings-report";
export const BUCKET_NAME = "alchemy-test-cur-bindings";

export class CurTestFunction extends Lambda.Function<Lambda.Function>()(
  "CurTestFunction",
) {}

export default CurTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The delivery bucket policy AWS validates before accepting a report
    // definition (billingreports.amazonaws.com needs GetBucketAcl/
    // GetBucketPolicy on the bucket and PutObject under it).
    const bucket = yield* Bucket("CurBindingsBucket", {
      bucketName: BUCKET_NAME,
      forceDestroy: true,
      policy: [
        {
          Effect: "Allow",
          Principal: { Service: "billingreports.amazonaws.com" },
          Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
          Resource: `arn:aws:s3:::${BUCKET_NAME}`,
        },
        {
          Effect: "Allow",
          Principal: { Service: "billingreports.amazonaws.com" },
          Action: ["s3:PutObject"],
          Resource: `arn:aws:s3:::${BUCKET_NAME}/*`,
        },
      ],
    });

    const report = yield* CostAndUsageReport.ReportDefinition(
      "CurBindingsReport",
      {
        reportName: REPORT_NAME,
        timeUnit: "DAILY",
        format: "textORcsv",
        compression: "GZIP",
        s3Bucket: bucket.bucketName,
        s3Prefix: "cur-bindings",
        s3Region: bucket.region,
        tags: { fixture: "cur-bindings" },
      },
    );

    // --- account-level bindings ---
    const describeReportDefinitions =
      yield* CostAndUsageReport.DescribeReportDefinitions();

    // --- report-scoped bindings ---
    const listReportTags =
      yield* CostAndUsageReport.ListTagsForResource(report);

    const bound = {
      describeReportDefinitions,
      listReportTags,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/reports") {
          const result = yield* describeReportDefinitions();
          const names = (result.ReportDefinitions ?? []).map(
            (r) => r.ReportName,
          );
          return yield* HttpServerResponse.json({
            count: names.length,
            names,
          });
        }

        if (request.method === "GET" && pathname === "/report-tags") {
          const result = yield* listReportTags();
          return yield* HttpServerResponse.json({
            tags: Object.fromEntries(
              (result.Tags ?? []).map((t) => [t.Key, t.Value]),
            ),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CostAndUsageReport.DescribeReportDefinitionsHttp,
        CostAndUsageReport.ListTagsForResourceHttp,
      ),
    ),
  ),
);
