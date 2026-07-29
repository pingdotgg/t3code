import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import MedicalImagingTestFunctionLive, {
  IMPORT_PREFIX,
  MedicalImagingTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// Well-formed-but-nonexistent ids (32 hex chars) the ungated probes are
// driven against.
const NONEXISTENT_DATASTORE = "0123456789abcdef0123456789abcdef";
const NONEXISTENT_IMAGE_SET = "0123456789abcdef0123456789abcdef";
const NONEXISTENT_JOB = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Ungated typed-error probes: every data-plane operation the eleven bindings
// wrap is exercised directly through distilled against a nonexistent data
// store, and must answer with its typed tag. Import-job routes consistently
// answer ResourceNotFoundException; image-set routes flip-flop between
// AccessDeniedException and ResourceNotFoundException (observed answering
// each within hours of the other in mid-2026), so those probes accept
// either typed tag. These prove the distilled error unions (and request
// serialization) at near-zero cost on every CI pass, while the full runtime
// fixture below is gated behind the multi-minute data store provisioning.
// ---------------------------------------------------------------------------

// AWS answers image-set routes on a nonexistent datastore with either tag
// depending on which backend handles the request; both are typed.
const expectNotFoundOrDenied = (error: { _tag: string }) =>
  expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(
    error._tag,
  );

describe("MedicalImaging data-plane operations (typed-error probes)", () => {
  test.provider(
    "getImageSet on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.getImageSet({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "getImageSetMetadata on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.getImageSetMetadata({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "getImageFrame on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.getImageFrame({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
            imageFrameInformation: { imageFrameId: NONEXISTENT_IMAGE_SET },
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "searchImageSets on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.searchImageSets({
            datastoreId: NONEXISTENT_DATASTORE,
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "listImageSetVersions on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.listImageSetVersions({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "updateImageSetMetadata on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.updateImageSetMetadata({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
            latestVersionId: "1",
            updateImageSetMetadataUpdates: { revertToVersionId: "1" },
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "copyImageSet on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.copyImageSet({
            datastoreId: NONEXISTENT_DATASTORE,
            sourceImageSetId: NONEXISTENT_IMAGE_SET,
            copyImageSetInformation: {
              sourceImageSet: { latestVersionId: "1" },
            },
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "deleteImageSet on a nonexistent datastore fails with a typed not-found/denied tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.deleteImageSet({
            datastoreId: NONEXISTENT_DATASTORE,
            imageSetId: NONEXISTENT_IMAGE_SET,
          }),
        );
        expectNotFoundOrDenied(error);
      }),
  );

  test.provider(
    "getDICOMImportJob on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.getDICOMImportJob({
            datastoreId: NONEXISTENT_DATASTORE,
            jobId: NONEXISTENT_JOB,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "listDICOMImportJobs on a nonexistent datastore fails with ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          medicalimaging.listDICOMImportJobs({
            datastoreId: NONEXISTENT_DATASTORE,
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
  );

  test.provider(
    "startDICOMImportJob on a nonexistent datastore fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* AWSEnvironment.current;
        const error = yield* Effect.flip(
          medicalimaging.startDICOMImportJob({
            datastoreId: NONEXISTENT_DATASTORE,
            clientToken: "alchemy-medicalimaging-probe",
            dataAccessRoleArn: `arn:aws:iam::${accountId}:role/alchemy-probe-nonexistent`,
            inputS3Uri: "s3://alchemy-probe-nonexistent/in/",
            outputS3Uri: "s3://alchemy-probe-nonexistent/out/",
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
// Full runtime fixture: a Lambda bound to all eleven data-plane bindings
// against a live HealthImaging data store. A data store takes a few minutes
// to provision (and must be empty to delete), so this is gated behind
// AWS_TEST_MEDICAL_IMAGING=1 (same gate as the Datastore lifecycle test) and
// always destroys what it created.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "MedicalImagingBindings");

test.provider.skipIf(!process.env.AWS_TEST_MEDICAL_IMAGING)(
  "image set + import job bindings against a live data store",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* MedicalImagingTestFunction;
          }).pipe(Effect.provide(MedicalImagingTestFunctionLive)),
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

        // All eleven capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(11);

        // Upload a (deliberately invalid) DICOM input out-of-band — the
        // import job still submits and runs; per-object failures land in
        // the output manifests.
        const config = (yield* getJson("/config")) as { bucketName: string };
        yield* s3.putObject({
          Bucket: config.bucketName,
          Key: `${IMPORT_PREFIX}not-a-dicom.dcm`,
          Body: new TextEncoder().encode("alchemy medical-imaging fixture"),
          ContentType: "application/dicom",
        });

        // StartDICOMImportJob — proves datastoreId + dataAccessRoleArn
        // injection and the iam:PassRole grant.
        const importJob = (yield* getJson("/import")) as {
          jobId?: string;
          status?: string;
          errorTag?: string;
        };
        expect(importJob.errorTag).toBeUndefined();
        expect(importJob.jobId).toBeTruthy();
        expect(importJob.status).toBe("SUBMITTED");

        // GetDICOMImportJob — the job is observable immediately.
        const described = (yield* getJson(
          `/describe-import?jobId=${importJob.jobId}`,
        )) as { status?: string; errorTag?: string };
        expect(described.errorTag).toBeUndefined();
        expect(described.status).toBeTruthy();

        // ListDICOMImportJobs sees it.
        const imports = (yield* getJson("/list-imports")) as { count: number };
        expect(imports.count).toBeGreaterThanOrEqual(1);

        // SearchImageSets — the store has no image sets (the import input
        // is invalid), so an empty result proves the grant + wiring.
        const search = (yield* getJson("/search")) as {
          count?: number;
          errorTag?: string;
        };
        expect(search.errorTag).toBeUndefined();
        expect(search.count).toBe(0);

        // Image-set-scoped bindings against a nonexistent image set: the
        // typed not-found tag (not AccessDeniedException) proves the IAM
        // grant on `{datastoreArn}/imageset/*` and the id injection.
        for (const route of [
          "/get-image-set",
          "/get-metadata",
          "/get-frame",
          "/versions",
          "/update-metadata",
          "/copy",
          "/delete-image-set",
        ]) {
          const result = (yield* getJson(route)) as { errorTag?: string };
          expect(result.errorTag).toBe("ResourceNotFoundException");
        }

        // Wait (bounded) for the import job to finish so the data store is
        // quiescent (and guaranteed image-set-free) before destroy.
        yield* getJson(`/describe-import?jobId=${importJob.jobId}`).pipe(
          Effect.map((r) => (r as { status: string }).status),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (status): boolean =>
              status !== "SUBMITTED" && status !== "IN_PROGRESS",
            times: 30,
          }),
        );
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  // data store create (a few minutes) + import job + async delete, one test.
  { timeout: 1_800_000 },
);
