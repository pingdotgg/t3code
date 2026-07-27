import * as HealthLake from "@/AWS/HealthLake";
import * as IAM from "@/AWS/IAM";
import * as KMS from "@/AWS/KMS";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** S3 prefix the gated test uploads FHIR NDJSON to before calling `/import`. */
export const IMPORT_PREFIX = "import/";

export class HealthLakeTestFunction extends Lambda.Function<Lambda.Function>()(
  "HealthLakeTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the identifier/role
 * injection, and the IAM grants. An untyped error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * Data-store-scoped binding fixture: deploys a real FHIR R4 data store
 * (~15-30 minutes to provision, billed while it exists — gated behind
 * AWS_TEST_HEALTHLAKE) plus the import/export supporting cast (S3 bucket,
 * KMS key, HealthLake data-access role) and a Lambda bound to all six job
 * bindings.
 */
export default HealthLakeTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("HealthLakeBindingsBucket", {
      forceDestroy: true,
    });

    const key = yield* KMS.Key("HealthLakeBindingsKey", {
      description: "healthlake bindings fixture output encryption key",
      deletionWindow: "7 days",
    });

    // The data-access role HealthLake assumes to read the import NDJSON and
    // write job output. Fixture-only wide grants; the interesting IAM (the
    // scoped healthlake:* + iam:PassRole statements) is what the bindings
    // attach to the Lambda itself.
    const role = yield* IAM.Role("HealthLakeBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "healthlake.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        DataAccess: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: [
                "kms:DescribeKey",
                "kms:GenerateDataKey",
                "kms:GenerateDataKey*",
                "kms:Decrypt",
                "kms:Encrypt",
              ],
              Resource: ["*"],
            },
          ],
        },
      },
    });

    const datastore = yield* HealthLake.FHIRDatastore("BindingsStore", {
      tags: { fixture: "healthlake-bindings" },
    });

    const startImport = yield* HealthLake.StartFHIRImportJob(datastore, role);
    const describeImport = yield* HealthLake.DescribeFHIRImportJob(datastore);
    const listImports = yield* HealthLake.ListFHIRImportJobs(datastore);
    const startExport = yield* HealthLake.StartFHIRExportJob(datastore, role);
    const describeExport = yield* HealthLake.DescribeFHIRExportJob(datastore);
    const listExports = yield* HealthLake.ListFHIRExportJobs(datastore);

    const bound = {
      startImport,
      describeImport,
      listImports,
      startExport,
      describeExport,
      listExports,
    };

    const BucketName = yield* bucket.bucketName;
    const KeyArn = yield* key.keyArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const bucketName = yield* BucketName;
        const kmsKeyId = yield* KeyArn;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          return yield* HttpServerResponse.json({ bucketName });
        }

        if (request.method === "GET" && pathname === "/import") {
          const result = yield* errorTagged(
            startImport({
              InputDataConfig: {
                S3Uri: `s3://${bucketName}/${IMPORT_PREFIX}`,
              },
              JobOutputDataConfig: {
                S3Configuration: {
                  S3Uri: `s3://${bucketName}/import-output/`,
                  KmsKeyId: kmsKeyId,
                },
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { jobId: result.JobId, status: result.JobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/describe-import") {
          const jobId = url.searchParams.get("jobId") ?? "";
          const result = yield* errorTagged(describeImport({ JobId: jobId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { status: result.ImportJobProperties.JobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/list-imports") {
          const result = yield* errorTagged(listImports());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.ImportJobPropertiesList.length },
          );
        }

        if (request.method === "GET" && pathname === "/export") {
          const result = yield* errorTagged(
            startExport({
              OutputDataConfig: {
                S3Configuration: {
                  S3Uri: `s3://${bucketName}/export/`,
                  KmsKeyId: kmsKeyId,
                },
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { jobId: result.JobId, status: result.JobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/describe-export") {
          const jobId = url.searchParams.get("jobId") ?? "";
          const result = yield* errorTagged(describeExport({ JobId: jobId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { status: result.ExportJobProperties.JobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/list-exports") {
          const result = yield* errorTagged(listExports());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.ExportJobPropertiesList.length },
          );
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
        HealthLake.StartFHIRImportJobHttp,
        HealthLake.DescribeFHIRImportJobHttp,
        HealthLake.ListFHIRImportJobsHttp,
        HealthLake.StartFHIRExportJobHttp,
        HealthLake.DescribeFHIRExportJobHttp,
        HealthLake.ListFHIRExportJobsHttp,
      ),
    ),
  ),
);
