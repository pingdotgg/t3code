import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Textract from "@/AWS/Textract";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { HELLO_PNG_BASE64 } from "./constants.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic checked-in test input, decoded once at module init.
const pngBytes = Buffer.from(HELLO_PNG_BASE64, "base64");

/** Key of the seeded input object the async Start* routes analyze. */
export const INPUT_KEY = "textract/hello.png";

export class TextractTestFunction extends Lambda.Function<Lambda.Function>()(
  "TextractTestFunction",
) {}

export default TextractTestFunction.make(
  {
    main,
    url: true,
    // Each sync analysis inference takes a few seconds; routes run several.
    timeout: Duration.seconds(60),
    // The bundled Textract schema graph is large — give headroom over the
    // 128 MB default.
    memorySize: 512,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("TextractInputBucket", {
      forceDestroy: true,
    });
    const adapter = yield* Textract.Adapter("TextractTestAdapter", {
      featureTypes: ["QUERIES"],
      description: "alchemy textract bindings fixture",
    });

    // Seeding route writes the input object; Textract's async Start* APIs
    // read the S3 input with the CALLER's credentials, so the function
    // itself also needs s3:GetObject on the bucket.
    const putObject = yield* S3.PutObject(bucket);
    yield* S3.GetObject(bucket);

    // --- synchronous analysis ---
    const analyzeDocument = yield* Textract.AnalyzeDocument();
    const analyzeExpense = yield* Textract.AnalyzeExpense();
    const analyzeID = yield* Textract.AnalyzeID();

    // --- asynchronous jobs ---
    const startDocumentTextDetection =
      yield* Textract.StartDocumentTextDetection();
    const getDocumentTextDetection = yield* Textract.GetDocumentTextDetection();
    const startDocumentAnalysis = yield* Textract.StartDocumentAnalysis();
    const getDocumentAnalysis = yield* Textract.GetDocumentAnalysis();
    const startExpenseAnalysis = yield* Textract.StartExpenseAnalysis();
    const getExpenseAnalysis = yield* Textract.GetExpenseAnalysis();
    const startLendingAnalysis = yield* Textract.StartLendingAnalysis();
    const getLendingAnalysis = yield* Textract.GetLendingAnalysis();
    const getLendingAnalysisSummary =
      yield* Textract.GetLendingAnalysisSummary();

    // --- adapter management ---
    const listAdapters = yield* Textract.ListAdapters();
    const getAdapter = yield* Textract.GetAdapter(adapter);
    const listAdapterVersions = yield* Textract.ListAdapterVersions(adapter);
    const getAdapterVersion = yield* Textract.GetAdapterVersion(adapter);
    const createAdapterVersion = yield* Textract.CreateAdapterVersion(adapter);
    const deleteAdapterVersion = yield* Textract.DeleteAdapterVersion(adapter);

    const BucketName = yield* bucket.bucketName;

    const lineTexts = (blocks: { BlockType?: string; Text?: string }[]) =>
      blocks.filter((b) => b.BlockType === "LINE").map((b) => b.Text);

    // Textract's adapter management APIs throttle at ~1 TPS; bounded backoff
    // absorbs the bursts the adapter routes emit.
    const throttleRetry = <A, E extends { readonly _tag: string }>(
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.retry({
          while: (e): boolean =>
            e._tag === "ProvisionedThroughputExceededException" ||
            e._tag === "ThrottlingException",
          schedule: Schedule.exponential("1 second"),
          times: 5,
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const jobId = url.searchParams.get("jobId") ?? "";
        // BucketName is an Output accessor — resolve it per invocation.
        const Bucket = yield* BucketName;
        const s3Input = {
          S3Object: { Bucket, Name: INPUT_KEY },
        };

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/seed") {
          yield* putObject({
            Key: INPUT_KEY,
            Body: pngBytes,
            ContentType: "image/png",
          });
          return yield* HttpServerResponse.json({ seeded: true });
        }

        // --- synchronous analysis ---
        if (request.method === "GET" && pathname === "/analyze-document") {
          const result = yield* analyzeDocument({
            Document: { Bytes: pngBytes },
            FeatureTypes: ["TABLES", "FORMS"],
          });
          return yield* HttpServerResponse.json({
            pages: result.DocumentMetadata?.Pages,
            lines: lineTexts(result.Blocks ?? []),
          });
        }

        if (request.method === "GET" && pathname === "/analyze-expense") {
          const result = yield* analyzeExpense({
            Document: { Bytes: pngBytes },
          });
          return yield* HttpServerResponse.json({
            pages: result.DocumentMetadata?.Pages,
            expenseDocuments: result.ExpenseDocuments?.length ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/analyze-id") {
          const result = yield* analyzeID({
            DocumentPages: [{ Bytes: pngBytes }],
          });
          return yield* HttpServerResponse.json({
            pages: result.DocumentMetadata?.Pages,
            identityDocuments: result.IdentityDocuments?.length ?? 0,
          });
        }

        // --- asynchronous jobs ---
        if (request.method === "POST" && pathname === "/start-text-detection") {
          const result = yield* startDocumentTextDetection({
            DocumentLocation: s3Input,
          });
          return yield* HttpServerResponse.json({ jobId: result.JobId });
        }

        if (request.method === "GET" && pathname === "/get-text-detection") {
          const result = yield* getDocumentTextDetection({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobStatus: result.JobStatus,
            lines: lineTexts(result.Blocks ?? []),
          });
        }

        if (request.method === "POST" && pathname === "/start-analysis") {
          const result = yield* startDocumentAnalysis({
            DocumentLocation: s3Input,
            FeatureTypes: ["TABLES"],
          });
          return yield* HttpServerResponse.json({ jobId: result.JobId });
        }

        if (request.method === "GET" && pathname === "/get-analysis") {
          const result = yield* getDocumentAnalysis({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobStatus: result.JobStatus,
            blocks: result.Blocks?.length ?? 0,
          });
        }

        if (request.method === "POST" && pathname === "/start-expense") {
          const result = yield* startExpenseAnalysis({
            DocumentLocation: s3Input,
          });
          return yield* HttpServerResponse.json({ jobId: result.JobId });
        }

        if (request.method === "GET" && pathname === "/get-expense") {
          const result = yield* getExpenseAnalysis({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobStatus: result.JobStatus,
            expenseDocuments: result.ExpenseDocuments?.length ?? 0,
          });
        }

        if (request.method === "POST" && pathname === "/start-lending") {
          const result = yield* startLendingAnalysis({
            DocumentLocation: s3Input,
          });
          return yield* HttpServerResponse.json({ jobId: result.JobId });
        }

        if (request.method === "GET" && pathname === "/get-lending") {
          const result = yield* getLendingAnalysis({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobStatus: result.JobStatus,
            results: result.Results?.length ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/get-lending-summary") {
          const result = yield* getLendingAnalysisSummary({ JobId: jobId });
          return yield* HttpServerResponse.json({
            jobStatus: result.JobStatus,
            documentGroups: result.Summary?.DocumentGroups?.length ?? 0,
          });
        }

        // --- adapter management ---
        if (request.method === "GET" && pathname === "/adapters") {
          const info = yield* throttleRetry(getAdapter());
          const listed = yield* throttleRetry(listAdapters());
          const versions = yield* throttleRetry(listAdapterVersions());
          return yield* HttpServerResponse.json({
            adapterName: info.AdapterName,
            featureTypes: info.FeatureTypes,
            listed: (listed.Adapters ?? []).map((a) => a.AdapterName),
            versionsCount: versions.AdapterVersions?.length ?? 0,
          });
        }

        // Typed-error probes — well-formed-but-nonexistent identifiers drive
        // the typed not-found/validation paths. An IAM gap would surface
        // AccessDeniedException (a 500 through the handler's orDie), so a
        // typed tag here proves the grant end-to-end.
        if (
          request.method === "GET" &&
          pathname === "/adapter-version-probes"
        ) {
          const getVersionProbe = yield* throttleRetry(
            getAdapterVersion({ AdapterVersion: "999" }),
          ).pipe(
            Effect.map(() => "unexpected-success"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          // DeleteAdapterVersion is idempotent — deleting a nonexistent
          // version returns success, which proves the grant just as well.
          const deleteVersionProbe = yield* throttleRetry(
            deleteAdapterVersion({ AdapterVersion: "999" }),
          ).pipe(
            Effect.map(() => "success"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "ConflictException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const createVersionProbe = yield* throttleRetry(
            createAdapterVersion({
              DatasetConfig: {
                ManifestS3Object: {
                  Bucket,
                  Name: "missing-manifest.jsonl",
                },
              },
              OutputConfig: {
                S3Bucket: Bucket,
                S3Prefix: "adapter-training/",
              },
            }),
          ).pipe(
            Effect.map(() => "unexpected-success"),
            Effect.catchTag(
              [
                "InvalidS3ObjectException",
                "InvalidParameterException",
                "ValidationException",
                "LimitExceededException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            getVersionProbe,
            deleteVersionProbe,
            createVersionProbe,
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
        S3.PutObjectHttp,
        S3.GetObjectHttp,
        Textract.AnalyzeDocumentHttp,
        Textract.AnalyzeExpenseHttp,
        Textract.AnalyzeIDHttp,
        Textract.StartDocumentTextDetectionHttp,
        Textract.GetDocumentTextDetectionHttp,
        Textract.StartDocumentAnalysisHttp,
        Textract.GetDocumentAnalysisHttp,
        Textract.StartExpenseAnalysisHttp,
        Textract.GetExpenseAnalysisHttp,
        Textract.StartLendingAnalysisHttp,
        Textract.GetLendingAnalysisHttp,
        Textract.GetLendingAnalysisSummaryHttp,
        Textract.ListAdaptersHttp,
        Textract.GetAdapterHttp,
        Textract.ListAdapterVersionsHttp,
        Textract.GetAdapterVersionHttp,
        Textract.CreateAdapterVersionHttp,
        Textract.DeleteAdapterVersionHttp,
      ),
    ),
  ),
);
