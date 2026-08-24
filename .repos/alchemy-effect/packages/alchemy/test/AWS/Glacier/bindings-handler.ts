import * as Glacier from "@/AWS/Glacier";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// A syntactically-valid-looking but nonexistent 138-char job/upload id.
const BOGUS_ID =
  "alchemy-nonexistent-glacier-id-000000000000000000000000000000000000";

export class GlacierBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "GlacierBindingsFunction",
) {}

export default GlacierBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const vault = yield* Glacier.Vault("BindingsVault");

    const describeVault = yield* Glacier.DescribeVault(vault);
    const uploadArchive = yield* Glacier.UploadArchive(vault);
    const deleteArchive = yield* Glacier.DeleteArchive(vault);
    const initiateJob = yield* Glacier.InitiateJob(vault);
    const describeJob = yield* Glacier.DescribeJob(vault);
    const listJobs = yield* Glacier.ListJobs(vault);
    const getJobOutput = yield* Glacier.GetJobOutput(vault);
    const initiateMultipartUpload =
      yield* Glacier.InitiateMultipartUpload(vault);
    const uploadMultipartPart = yield* Glacier.UploadMultipartPart(vault);
    const completeMultipartUpload =
      yield* Glacier.CompleteMultipartUpload(vault);
    const abortMultipartUpload = yield* Glacier.AbortMultipartUpload(vault);
    const listMultipartUploads = yield* Glacier.ListMultipartUploads(vault);
    const listParts = yield* Glacier.ListParts(vault);

    const bound = {
      describeVault,
      uploadArchive,
      deleteArchive,
      initiateJob,
      describeJob,
      listJobs,
      getJobOutput,
      initiateMultipartUpload,
      uploadMultipartPart,
      completeMultipartUpload,
      abortMultipartUpload,
      listMultipartUploads,
      listParts,
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

        if (request.method === "GET" && pathname === "/vault") {
          // vaultName injection scopes the call to the bound vault.
          const response = yield* describeVault();
          return yield* HttpServerResponse.json({
            vaultName: response.VaultName,
            numberOfArchives: response.NumberOfArchives ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const response = yield* listJobs();
          return yield* HttpServerResponse.json({
            count: (response.JobList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/uploads") {
          const response = yield* listMultipartUploads();
          return yield* HttpServerResponse.json({
            count: (response.UploadsList ?? []).length,
          });
        }

        // Each typed-not-found route proves the grant + injection
        // end-to-end: an IAM gap would surface AccessDeniedException (a
        // 500), while the typed ResourceNotFoundException proves the request
        // reached the vault-scoped API.
        if (request.method === "GET" && pathname === "/jobs/typed-not-found") {
          const typed = yield* describeJob({ jobId: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (
          request.method === "GET" &&
          pathname === "/job-output/typed-not-found"
        ) {
          const typed = yield* getJobOutput({ jobId: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "GET" && pathname === "/parts/typed-not-found") {
          const typed = yield* listParts({ uploadId: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (
          request.method === "POST" &&
          pathname === "/multipart/typed-not-found"
        ) {
          // All three mutation ops on a nonexistent upload id round-trip to
          // the typed ResourceNotFoundException without writing anything —
          // the vault stays empty so stack.destroy can delete it.
          const upload = yield* uploadMultipartPart({
            uploadId: BOGUS_ID,
            range: "bytes 0-1048575/*",
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          const complete = yield* completeMultipartUpload({
            uploadId: BOGUS_ID,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          const abort = yield* abortMultipartUpload({
            uploadId: BOGUS_ID,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ upload, complete, abort });
        }

        if (
          request.method === "POST" &&
          pathname === "/archive/typed-not-found"
        ) {
          // DeleteArchive is documented idempotent for already-deleted
          // archives, but a syntactically-bogus id surfaces the typed
          // not-found / bad-parameter union — either tag proves the grant.
          const typed = yield* deleteArchive({ archiveId: BOGUS_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "POST" && pathname === "/archive/probe") {
          // UploadArchive with a deliberately-wrong checksum: the service
          // rejects the write with a typed 400 before storing anything, so
          // the vault deletes cleanly at stack.destroy. A successful write
          // here would block DeleteVault for ~24h (until the next
          // inventory).
          const typed = yield* uploadArchive({
            checksum: "0".repeat(64),
            body: "alchemy-glacier-binding-probe",
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "InvalidParameterValueException",
                "MissingParameterValueException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "POST" && pathname === "/multipart/probe") {
          // Initiate requires a power-of-two MiB part size; a size of 1 is
          // rejected with the typed 400 before any upload is created.
          const typed = yield* initiateMultipartUpload({
            archiveDescription: "alchemy-glacier-binding-probe",
            partSize: "1",
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "InvalidParameterValueException",
                "MissingParameterValueException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "POST" && pathname === "/jobs/inventory") {
          // A brand-new vault has no inventory yet — Glacier rejects the
          // inventory-retrieval with a typed 400 until the first nightly
          // inventory runs. Either branch proves InitiateJob's grant.
          const result = yield* initiateJob({
            jobParameters: { Type: "inventory-retrieval" },
          }).pipe(
            Effect.map((r) => ({ started: true, jobId: r.jobId })),
            Effect.catchTag(
              ["InvalidParameterValueException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ started: false, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
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
        Glacier.DescribeVaultHttp,
        Glacier.UploadArchiveHttp,
        Glacier.DeleteArchiveHttp,
        Glacier.InitiateJobHttp,
        Glacier.DescribeJobHttp,
        Glacier.ListJobsHttp,
        Glacier.GetJobOutputHttp,
        Glacier.InitiateMultipartUploadHttp,
        Glacier.UploadMultipartPartHttp,
        Glacier.CompleteMultipartUploadHttp,
        Glacier.AbortMultipartUploadHttp,
        Glacier.ListMultipartUploadsHttp,
        Glacier.ListPartsHttp,
      ),
    ),
  ),
);
