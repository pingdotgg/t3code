import * as BDA from "@/AWS/BedrockDataAutomation";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const INPUT_KEY = "inputs/hello.pdf";

// Minimal single-page PDF, checked in as a constant (never generated at test
// time). The async invoke only needs a readable S3 object — the job's final
// verdict is irrelevant to the binding test.
const TINY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 46>>stream
BT /F1 24 Tf 72 720 Td (Hello Alchemy) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF
`;

// A deterministic, valid BDA blueprint schema (checked-in constant fixture).
const INVOICE_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  description: "Extract invoice fields",
  class: "invoice",
  type: "object",
  definitions: {},
  properties: {
    invoice_number: {
      type: "string",
      inferenceType: "explicit",
      instruction: "The invoice number",
    },
  },
});

export class BdaTestFunction extends Lambda.Function<Lambda.Function>()(
  "BdaTestFunction",
) {}

export default BdaTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const project = yield* BDA.DataAutomationProject("BindingsProject", {
      projectDescription: "alchemy bindings test project",
      standardOutputConfiguration: {
        document: {
          extraction: {
            granularity: { types: ["DOCUMENT"] },
            boundingBox: { state: "DISABLED" },
          },
          generativeField: { state: "DISABLED" },
          outputFormat: {
            textFormat: { types: ["MARKDOWN"] },
            additionalFileFormat: { state: "DISABLED" },
          },
        },
      },
    });
    const blueprint = yield* BDA.Blueprint("BindingsBlueprint", {
      type: "DOCUMENT",
      schema: INVOICE_SCHEMA,
    });
    const library = yield* BDA.DataAutomationLibrary("BindingsLibrary", {
      libraryDescription: "alchemy bindings test library",
    });
    // Bedrock Data Automation reads the input and writes the output with the
    // CALLER's S3 permissions (forward access sessions), so the Lambda role
    // needs GetObject + PutObject on the working bucket.
    const bucket = yield* S3.Bucket("BindingsBucket", { forceDestroy: true });
    const bucketName = yield* bucket.bucketName;

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const invokeDataAutomationAsync =
      yield* BDA.InvokeDataAutomationAsync(project);
    const invokeDataAutomation = yield* BDA.InvokeDataAutomation(project);
    const getDataAutomationStatus = yield* BDA.GetDataAutomationStatus();
    const ingestLibraryEntities =
      yield* BDA.InvokeDataAutomationLibraryIngestionJob(library);
    const getLibraryIngestionJob =
      yield* BDA.GetDataAutomationLibraryIngestionJob(library);
    const listLibraryIngestionJobs =
      yield* BDA.ListDataAutomationLibraryIngestionJobs(library);
    const getLibraryEntity = yield* BDA.GetDataAutomationLibraryEntity(library);
    const listLibraryEntities =
      yield* BDA.ListDataAutomationLibraryEntities(library);
    const createBlueprintVersion = yield* BDA.CreateBlueprintVersion(blueprint);
    const copyBlueprintStage = yield* BDA.CopyBlueprintStage(blueprint);
    const invokeBlueprintOptimizationAsync =
      yield* BDA.InvokeBlueprintOptimizationAsync(blueprint);
    const getBlueprintOptimizationStatus =
      yield* BDA.GetBlueprintOptimizationStatus();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.bedrock) targeting this Function. Runtime firing needs a settled
    // job with eventBridgeEnabled, so the test only verifies the
    // subscription deploys.
    yield* BDA.consumeDataAutomationJobEvents(
      { kinds: ["succeeded", "client-error", "service-error"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `data automation job ${event.detail.job_id}: ${event.detail.job_status}`,
          ),
        ),
    );

    const bound = {
      putObject,
      getObject,
      invokeDataAutomationAsync,
      invokeDataAutomation,
      getDataAutomationStatus,
      ingestLibraryEntities,
      getLibraryIngestionJob,
      listLibraryIngestionJobs,
      getLibraryEntity,
      listLibraryEntities,
      createBlueprintVersion,
      copyBlueprintStage,
      invokeBlueprintOptimizationAsync,
      getBlueprintOptimizationStatus,
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

        if (request.method === "POST" && pathname === "/invoke-async") {
          // Uploads the fixture document, then submits an async job against
          // the bound project. The response arrives before the job settles —
          // the test asserts the invocation ARN shape and polls status once.
          const profileArn = url.searchParams.get("profileArn")!;
          // Double-yield: the init-scope yield gives an accessor; yielding
          // it here resolves the physical bucket name at runtime.
          const physicalBucket = yield* bucketName;
          const result = yield* putObject({
            Key: INPUT_KEY,
            Body: TINY_PDF,
            ContentType: "application/pdf",
          }).pipe(
            Effect.flatMap(() =>
              invokeDataAutomationAsync({
                inputConfiguration: {
                  s3Uri: `s3://${physicalBucket}/${INPUT_KEY}`,
                },
                outputConfiguration: {
                  s3Uri: `s3://${physicalBucket}/results/`,
                },
                dataAutomationProfileArn: profileArn,
                notificationConfiguration: {
                  eventBridgeConfiguration: { eventBridgeEnabled: true },
                },
              }),
            ),
            Effect.map((r) => ({ invocationArn: r.invocationArn })),
            // Surface the typed failure to the test instead of a bare 500 —
            // the assertion prints the tag + message on mismatch.
            Effect.catch((e) =>
              Effect.succeed({
                invocationArn: undefined,
                error: e._tag,
                message: String((e as { message?: unknown }).message ?? ""),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/status") {
          const invocationArn = url.searchParams.get("invocationArn")!;
          const result = yield* getDataAutomationStatus({ invocationArn });
          return yield* HttpServerResponse.json({ status: result.status });
        }

        if (
          request.method === "POST" &&
          pathname === "/invoke-sync-validation"
        ) {
          // The sync API needs a SYNC project and a non-empty input; driving
          // it through the typed ValidationException path proves the IAM
          // grant + project injection end-to-end — an IAM gap would surface
          // AccessDeniedException (a 500 through orDie) instead.
          const profileArn = url.searchParams.get("profileArn")!;
          const tag = yield* invokeDataAutomation({
            inputConfiguration: {},
            dataAutomationProfileArn: profileArn,
          }).pipe(
            Effect.map(() => "Invoked"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "POST" && pathname === "/library-ingest") {
          // Starts an inline UPSERT ingestion job against the bound library.
          // Results land in the fixture bucket with the caller's S3
          // permissions.
          const physicalBucket = yield* bucketName;
          const result = yield* ingestLibraryEntities({
            entityType: "VOCABULARY",
            operationType: "UPSERT",
            inputConfiguration: {
              inlinePayload: {
                upsertEntitiesInfo: [
                  {
                    vocabulary: {
                      language: "EN",
                      phrases: [{ text: "Alchemy", displayAsText: "Alchemy" }],
                    },
                  },
                ],
              },
            },
            outputConfiguration: {
              s3Uri: `s3://${physicalBucket}/library-results/`,
            },
          }).pipe(
            Effect.map((r) => ({ jobArn: r.jobArn })),
            // Surface the FULL cause (typed failure or defect) to the test —
            // the assertion prints it on mismatch.
            Effect.catchCause((cause) =>
              Effect.succeed({
                jobArn: undefined,
                error: "Cause",
                message: String(cause),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/library-ingestion-job") {
          const jobArn = url.searchParams.get("jobArn")!;
          const result = yield* getLibraryIngestionJob({ jobArn });
          return yield* HttpServerResponse.json({
            status: result.job?.jobStatus,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/library-ingestion-jobs"
        ) {
          const result = yield* listLibraryIngestionJobs({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (result.jobs ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/library-entities") {
          const result = yield* listLibraryEntities({
            entityType: "VOCABULARY",
            maxResults: 25,
          });
          return yield* HttpServerResponse.json({
            count: (result.entities ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/library-entity-missing"
        ) {
          // Proves bedrock:GetDataAutomationLibraryEntity + library injection
          // via the typed not-found path — an IAM gap would surface
          // AccessDeniedException (a 500 through orDie) instead of the tag.
          const tag = yield* getLibraryEntity({
            entityType: "VOCABULARY",
            entityId: "nonexistent-alchemy-probe",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(`Cause: ${String(cause)}`),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "POST" && pathname === "/blueprint-version") {
          const result = yield* createBlueprintVersion({}).pipe(
            Effect.map((r) => ({
              version: r.blueprint.blueprintVersion,
              arn: r.blueprint.blueprintArn,
            })),
            Effect.catch((e) =>
              Effect.succeed({
                version: undefined,
                arn: undefined,
                error: e._tag,
                message: String((e as { message?: unknown }).message ?? ""),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "POST" &&
          pathname === "/copy-stage-validation"
        ) {
          // The fixture blueprint only exists in LIVE, so copying from the
          // (absent) DEVELOPMENT stage drives the typed error path without
          // creating a second stage copy the stack would have to clean up.
          const tag = yield* copyBlueprintStage({
            sourceStage: "DEVELOPMENT",
            targetStage: "LIVE",
          }).pipe(
            Effect.map(() => "Copied"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(`Cause: ${String(cause)}`),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "POST" && pathname === "/optimize-validation") {
          // An empty samples list is invalid (min 1 labeled pair), so this
          // drives the typed ValidationException path — proving IAM +
          // blueprint injection without starting (and paying for) a real
          // optimization job.
          const profileArn = url.searchParams.get("profileArn")!;
          const physicalBucket = yield* bucketName;
          const tag = yield* invokeBlueprintOptimizationAsync({
            samples: [],
            outputConfiguration: {
              s3Object: {
                s3Uri: `s3://${physicalBucket}/optimization-results/`,
              },
            },
            dataAutomationProfileArn: profileArn,
          }).pipe(
            Effect.map(() => "Invoked"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(`Cause: ${String(cause)}`),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/optimization-status-missing"
        ) {
          // Proves bedrock:GetBlueprintOptimizationStatus via the typed
          // not-found path on a well-formed but nonexistent invocation ARN
          // supplied by the test.
          const invocationArn = url.searchParams.get("invocationArn")!;
          const tag = yield* getBlueprintOptimizationStatus({
            invocationArn,
          }).pipe(
            Effect.map((r) => r.status ?? "Unknown"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(`Cause: ${String(cause)}`),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
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
        Lambda.EventSource,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
        BDA.InvokeDataAutomationAsyncHttp,
        BDA.InvokeDataAutomationHttp,
        BDA.GetDataAutomationStatusHttp,
        BDA.InvokeDataAutomationLibraryIngestionJobHttp,
        BDA.GetDataAutomationLibraryIngestionJobHttp,
        BDA.ListDataAutomationLibraryIngestionJobsHttp,
        BDA.GetDataAutomationLibraryEntityHttp,
        BDA.ListDataAutomationLibraryEntitiesHttp,
        BDA.CreateBlueprintVersionHttp,
        BDA.CopyBlueprintStageHttp,
        BDA.InvokeBlueprintOptimizationAsyncHttp,
        BDA.GetBlueprintOptimizationStatusHttp,
      ),
    ),
  ),
);
