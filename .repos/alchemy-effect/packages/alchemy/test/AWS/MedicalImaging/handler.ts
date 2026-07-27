import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as MedicalImaging from "@/AWS/MedicalImaging";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** S3 prefix the gated test uploads DICOM input to before calling `/import`. */
export const IMPORT_PREFIX = "dicom-input/";

export class MedicalImagingTestFunction extends Lambda.Function<Lambda.Function>()(
  "MedicalImagingTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the identifier/role
 * injection, and the IAM grants (a missing grant surfaces as
 * `AccessDeniedException`, not `ResourceNotFoundException`). An untyped
 * error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

// A well-formed (32 hex chars) but nonexistent image set id — image-set
// routes prove wiring + IAM by observing the typed not-found tag.
const NONEXISTENT_IMAGE_SET = "0123456789abcdef0123456789abcdef";

/**
 * Data-store-scoped binding fixture: deploys a real HealthImaging data
 * store (provisions in a few minutes — gated behind
 * AWS_TEST_MEDICAL_IMAGING) plus the import supporting cast (S3 bucket,
 * HealthImaging data-access role) and a Lambda bound to all eleven
 * data-plane bindings.
 */
export default MedicalImagingTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("MedicalImagingBindingsBucket", {
      forceDestroy: true,
    });

    // The data-access role HealthImaging assumes to read the DICOM P10
    // input and write the import manifests. Fixture-only wide grants; the
    // interesting IAM (the scoped medical-imaging:* + iam:PassRole
    // statements) is what the bindings attach to the Lambda itself.
    const role = yield* IAM.Role("MedicalImagingBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "medical-imaging.amazonaws.com" },
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
          ],
        },
      },
    });

    const datastore = yield* MedicalImaging.Datastore("BindingsStore", {
      tags: { fixture: "medical-imaging-bindings" },
    });

    const startImport = yield* MedicalImaging.StartDICOMImportJob(
      datastore,
      role,
    );
    const getImportJob = yield* MedicalImaging.GetDICOMImportJob(datastore);
    const listImportJobs = yield* MedicalImaging.ListDICOMImportJobs(datastore);
    const searchImageSets = yield* MedicalImaging.SearchImageSets(datastore);
    const getImageSet = yield* MedicalImaging.GetImageSet(datastore);
    const getImageSetMetadata =
      yield* MedicalImaging.GetImageSetMetadata(datastore);
    const getImageFrame = yield* MedicalImaging.GetImageFrame(datastore);
    const listImageSetVersions =
      yield* MedicalImaging.ListImageSetVersions(datastore);
    const updateImageSetMetadata =
      yield* MedicalImaging.UpdateImageSetMetadata(datastore);
    const copyImageSet = yield* MedicalImaging.CopyImageSet(datastore);
    const deleteImageSet = yield* MedicalImaging.DeleteImageSet(datastore);

    const bound = {
      startImport,
      getImportJob,
      listImportJobs,
      searchImageSets,
      getImageSet,
      getImageSetMetadata,
      getImageFrame,
      listImageSetVersions,
      updateImageSetMetadata,
      copyImageSet,
      deleteImageSet,
    };

    const BucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const bucketName = yield* BucketName;
        const imageSetId =
          url.searchParams.get("imageSetId") ?? NONEXISTENT_IMAGE_SET;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          return yield* HttpServerResponse.json({ bucketName });
        }

        // StartDICOMImportJob — proves datastoreId + dataAccessRoleArn
        // injection and the iam:PassRole grant.
        if (request.method === "GET" && pathname === "/import") {
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          const result = yield* errorTagged(
            startImport({
              clientToken,
              inputS3Uri: `s3://${bucketName}/${IMPORT_PREFIX}`,
              outputS3Uri: `s3://${bucketName}/dicom-output/`,
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { jobId: result.jobId, status: result.jobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/describe-import") {
          const jobId = url.searchParams.get("jobId") ?? "";
          const result = yield* errorTagged(getImportJob({ jobId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { status: result.jobProperties.jobStatus },
          );
        }

        if (request.method === "GET" && pathname === "/list-imports") {
          const result = yield* errorTagged(listImportJobs());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.jobSummaries.length },
          );
        }

        if (request.method === "GET" && pathname === "/search") {
          const result = yield* errorTagged(searchImageSets());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.imageSetsMetadataSummaries.length },
          );
        }

        if (request.method === "GET" && pathname === "/get-image-set") {
          const result = yield* errorTagged(getImageSet({ imageSetId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { state: result.imageSetState, versionId: result.versionId },
          );
        }

        if (request.method === "GET" && pathname === "/get-metadata") {
          const result = yield* errorTagged(
            getImageSetMetadata({ imageSetId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { contentType: result.contentType ?? "unknown" },
          );
        }

        if (request.method === "GET" && pathname === "/get-frame") {
          const result = yield* errorTagged(
            getImageFrame({
              imageSetId,
              imageFrameInformation: {
                imageFrameId: NONEXISTENT_IMAGE_SET,
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { contentType: result.contentType ?? "unknown" },
          );
        }

        if (request.method === "GET" && pathname === "/versions") {
          const result = yield* errorTagged(
            listImageSetVersions({ imageSetId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.imageSetPropertiesList.length },
          );
        }

        if (request.method === "GET" && pathname === "/update-metadata") {
          const result = yield* errorTagged(
            updateImageSetMetadata({
              imageSetId,
              latestVersionId: "1",
              updateImageSetMetadataUpdates: { revertToVersionId: "1" },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { versionId: result.latestVersionId },
          );
        }

        if (request.method === "GET" && pathname === "/copy") {
          const result = yield* errorTagged(
            copyImageSet({
              sourceImageSetId: imageSetId,
              copyImageSetInformation: {
                sourceImageSet: { latestVersionId: "1" },
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  imageSetId: result.destinationImageSetProperties.imageSetId,
                },
          );
        }

        if (request.method === "GET" && pathname === "/delete-image-set") {
          const result = yield* errorTagged(deleteImageSet({ imageSetId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { status: result.imageSetWorkflowStatus },
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
        MedicalImaging.StartDICOMImportJobHttp,
        MedicalImaging.GetDICOMImportJobHttp,
        MedicalImaging.ListDICOMImportJobsHttp,
        MedicalImaging.SearchImageSetsHttp,
        MedicalImaging.GetImageSetHttp,
        MedicalImaging.GetImageSetMetadataHttp,
        MedicalImaging.GetImageFrameHttp,
        MedicalImaging.ListImageSetVersionsHttp,
        MedicalImaging.UpdateImageSetMetadataHttp,
        MedicalImaging.CopyImageSetHttp,
        MedicalImaging.DeleteImageSetHttp,
      ),
    ),
  ),
);
