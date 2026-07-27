import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as healthlake from "@distilled.cloud/aws/healthlake";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import HealthLakeTestFunctionLive, {
  HealthLakeTestFunction,
  IMPORT_PREFIX,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// A well-formed-but-nonexistent data store id (32 hex chars) the ungated
// probes are driven against.
const NONEXISTENT_DATASTORE = "0123456789abcdef0123456789abcdef";
const NONEXISTENT_JOB = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Ungated typed-error probes: every job operation the six bindings wrap is
// exercised directly through distilled against a nonexistent data store, and
// must answer with the typed not-found tag the bindings' consumers handle.
// These prove the distilled error unions (and request serialization) at
// near-zero cost on every CI pass, while the full runtime fixture below is
// gated behind the 15-30 minute data store provisioning.
// ---------------------------------------------------------------------------

describe("HealthLake job operations (typed-error probes)", () => {
  test.provider(
    "describeFHIRImportJob on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          healthlake.describeFHIRImportJob({
            DatastoreId: NONEXISTENT_DATASTORE,
            JobId: NONEXISTENT_JOB,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "describeFHIRExportJob on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          healthlake.describeFHIRExportJob({
            DatastoreId: NONEXISTENT_DATASTORE,
            JobId: NONEXISTENT_JOB,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "listFHIRImportJobs on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          healthlake.listFHIRImportJobs({
            DatastoreId: NONEXISTENT_DATASTORE,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "listFHIRExportJobs on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          healthlake.listFHIRExportJobs({
            DatastoreId: NONEXISTENT_DATASTORE,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "startFHIRExportJob on a nonexistent datastore fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* AWSEnvironment.current;
        const error = yield* Effect.flip(
          healthlake.startFHIRExportJob({
            DatastoreId: NONEXISTENT_DATASTORE,
            DataAccessRoleArn: `arn:aws:iam::${accountId}:role/alchemy-probe-nonexistent`,
            OutputDataConfig: {
              S3Configuration: {
                S3Uri: "s3://alchemy-probe-nonexistent/export/",
                KmsKeyId: `arn:aws:kms:us-east-1:${accountId}:key/00000000-0000-0000-0000-000000000000`,
              },
            },
          }),
        );
        expect([
          "ResourceNotFoundException",
          "ValidationException",
          "AccessDeniedException",
        ]).toContain(error._tag);
      }),
  );

  test.provider(
    "startFHIRImportJob on a nonexistent datastore fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* AWSEnvironment.current;
        const error = yield* Effect.flip(
          healthlake.startFHIRImportJob({
            DatastoreId: NONEXISTENT_DATASTORE,
            DataAccessRoleArn: `arn:aws:iam::${accountId}:role/alchemy-probe-nonexistent`,
            InputDataConfig: { S3Uri: "s3://alchemy-probe-nonexistent/in/" },
            JobOutputDataConfig: {
              S3Configuration: {
                S3Uri: "s3://alchemy-probe-nonexistent/out/",
                KmsKeyId: `arn:aws:kms:us-east-1:${accountId}:key/00000000-0000-0000-0000-000000000000`,
              },
            },
          }),
        );
        expect([
          "ResourceNotFoundException",
          "ValidationException",
          "AccessDeniedException",
        ]).toContain(error._tag);
      }),
  );
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Lambda bound to all six job bindings against a live
// FHIR data store. A data store takes ~15-30 minutes to provision and bills
// while it exists, so this is gated behind AWS_TEST_HEALTHLAKE=1 (same gate
// as the FHIRDatastore lifecycle test) and always destroys what it created.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "HealthLakeBindings");

// A single synthetic FHIR R4 Patient in NDJSON form — the smallest valid
// import payload.
const PATIENT_NDJSON = JSON.stringify({
  resourceType: "Patient",
  id: "alchemy-bindings-patient",
  name: [{ family: "Alchemy", given: ["Bindings"] }],
  gender: "unknown",
});

test.provider.skipIf(!process.env.AWS_TEST_HEALTHLAKE)(
  "import + export job bindings against a live FHIR data store",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* HealthLakeTestFunction;
          }).pipe(Effect.provide(HealthLakeTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All six capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(6);

        // Upload the smallest valid import payload out-of-band.
        const config = (yield* getJson("/config")) as { bucketName: string };
        yield* s3.putObject({
          Bucket: config.bucketName,
          Key: `${IMPORT_PREFIX}patient.ndjson`,
          Body: new TextEncoder().encode(PATIENT_NDJSON),
          ContentType: "application/x-ndjson",
        });

        // StartFHIRImportJob — proves DatastoreId + DataAccessRoleArn
        // injection and the iam:PassRole grant.
        const importJob = (yield* getJson("/import")) as {
          jobId?: string;
          status?: string;
          errorTag?: string;
        };
        expect(importJob.errorTag).toBeUndefined();
        expect(importJob.jobId).toBeTruthy();
        expect(importJob.status).toBe("SUBMITTED");

        // DescribeFHIRImportJob — the job is observable immediately.
        const describedImport = (yield* getJson(
          `/describe-import?jobId=${importJob.jobId}`,
        )) as { status?: string; errorTag?: string };
        expect(describedImport.errorTag).toBeUndefined();
        expect(describedImport.status).toBeTruthy();

        // ListFHIRImportJobs sees it.
        const imports = (yield* getJson("/list-imports")) as { count: number };
        expect(imports.count).toBeGreaterThanOrEqual(1);

        // Wait (bounded) for the import to leave the submitted/in-progress
        // states so the concurrent export below is not rejected.
        yield* getJson(`/describe-import?jobId=${importJob.jobId}`).pipe(
          Effect.map((r) => (r as { status: string }).status),
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (status): boolean =>
              status !== "SUBMITTED" &&
              status !== "QUEUED" &&
              status !== "IN_PROGRESS",
            times: 60,
          }),
        );

        // StartFHIRExportJob + DescribeFHIRExportJob + ListFHIRExportJobs.
        const exportJob = (yield* getJson("/export")) as {
          jobId?: string;
          status?: string;
          errorTag?: string;
        };
        expect(exportJob.errorTag).toBeUndefined();
        expect(exportJob.jobId).toBeTruthy();
        expect(exportJob.status).toBe("SUBMITTED");

        const describedExport = (yield* getJson(
          `/describe-export?jobId=${exportJob.jobId}`,
        )) as { status?: string; errorTag?: string };
        expect(describedExport.errorTag).toBeUndefined();
        expect(describedExport.status).toBeTruthy();

        const exports = (yield* getJson("/list-exports")) as { count: number };
        expect(exports.count).toBeGreaterThanOrEqual(1);

        // Wait (bounded) for the export to finish so the bucket/data store
        // are quiescent before destroy.
        yield* getJson(`/describe-export?jobId=${exportJob.jobId}`).pipe(
          Effect.map((r) => (r as { status: string }).status),
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (status): boolean =>
              status !== "SUBMITTED" &&
              status !== "QUEUED" &&
              status !== "IN_PROGRESS",
            times: 60,
          }),
        );
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  // data store create (~15-30 min) + import + export + delete wait, one test.
  { timeout: 5_400_000 },
);
