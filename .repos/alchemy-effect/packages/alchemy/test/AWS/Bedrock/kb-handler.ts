import * as Bedrock from "@/AWS/Bedrock";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "kb-handler.ts");

// Same env-gated vector-store prerequisites as KnowledgeBase.slow.test.ts —
// this fixture only ever deploys from that (skipIf-gated) suite.
const roleArn = process.env.BEDROCK_KB_ROLE_ARN ?? "";
const collectionArn = process.env.BEDROCK_KB_COLLECTION_ARN ?? "";
const indexName = process.env.BEDROCK_KB_INDEX_NAME ?? "bedrock-index";
const embeddingModelArn = process.env.BEDROCK_KB_EMBEDDING_MODEL_ARN ?? "";

// Nova Micro via the us cross-region inference profile — the cheapest
// on-demand generation model in the testing account.
const MODEL = "us.amazon.nova-micro-v1:0";

const DOC_ID = "welcome-doc";
const DOC_TEXT =
  "Alchemy is an Infrastructure-as-Effects framework that deploys cloud resources from typed Effect programs.";

export class BedrockKbTestFunction extends Lambda.Function<Lambda.Function>()(
  "BedrockKbTestFunction",
) {}

export default BedrockKbTestFunction.make(
  {
    main,
    url: true,
    // Retrieval + generation regularly exceed Lambda's 3s default timeout.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("kb-docs", { forceDestroy: true });
    const kb = yield* Bedrock.KnowledgeBase("BindingsKb", {
      roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
        },
      },
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn,
          vectorIndexName: indexName,
          fieldMapping: {
            vectorField: "bedrock-vector",
            textField: "bedrock-text",
            metadataField: "bedrock-metadata",
          },
        },
      },
    });
    // S3-backed source exercises the ingestion-job bindings; CUSTOM source
    // exercises direct document ingestion.
    const s3Source = yield* Bedrock.DataSource("BindingsS3Source", {
      knowledgeBaseId: kb.knowledgeBaseId,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: { bucketArn: bucket.bucketArn },
      },
      dataDeletionPolicy: "DELETE",
    });
    const customSource = yield* Bedrock.DataSource("BindingsCustomSource", {
      knowledgeBaseId: kb.knowledgeBaseId,
      dataSourceConfiguration: { type: "CUSTOM" },
      dataDeletionPolicy: "DELETE",
    });

    const knowledgeBaseId = yield* kb.knowledgeBaseId;

    const ingestDocuments =
      yield* Bedrock.IngestKnowledgeBaseDocuments(customSource);
    const getDocuments = yield* Bedrock.GetKnowledgeBaseDocuments(customSource);
    const listDocuments =
      yield* Bedrock.ListKnowledgeBaseDocuments(customSource);
    const deleteDocuments =
      yield* Bedrock.DeleteKnowledgeBaseDocuments(customSource);
    const startIngestionJob = yield* Bedrock.StartIngestionJob(s3Source);
    const getIngestionJob = yield* Bedrock.GetIngestionJob(s3Source);
    const listIngestionJobs = yield* Bedrock.ListIngestionJobs(s3Source);
    const retrieve = yield* Bedrock.Retrieve(kb);
    const ragStream = yield* Bedrock.RetrieveAndGenerateStream(kb, MODEL);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Bedrock call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/ingest") {
          const { documentDetails } = yield* ingestDocuments({
            documents: [
              {
                content: {
                  dataSourceType: "CUSTOM",
                  custom: {
                    customDocumentIdentifier: { id: DOC_ID },
                    sourceType: "IN_LINE",
                    inlineContent: {
                      type: "TEXT",
                      textContent: { data: DOC_TEXT },
                    },
                  },
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            status: documentDetails?.[0]?.status,
          });
        }

        if (request.method === "GET" && pathname === "/doc-status") {
          const { documentDetails } = yield* getDocuments({
            documentIdentifiers: [
              { dataSourceType: "CUSTOM", custom: { id: DOC_ID } },
            ],
          });
          return yield* HttpServerResponse.json({
            status: documentDetails?.[0]?.status,
          });
        }

        if (request.method === "GET" && pathname === "/docs") {
          const { documentDetails } = yield* listDocuments({});
          return yield* HttpServerResponse.json({
            count: documentDetails?.length ?? 0,
          });
        }

        if (request.method === "POST" && pathname === "/delete-doc") {
          const { documentDetails } = yield* deleteDocuments({
            documentIdentifiers: [
              { dataSourceType: "CUSTOM", custom: { id: DOC_ID } },
            ],
          });
          return yield* HttpServerResponse.json({
            status: documentDetails?.[0]?.status,
          });
        }

        if (request.method === "POST" && pathname === "/sync") {
          const { ingestionJob } = yield* startIngestionJob({});
          return yield* HttpServerResponse.json({
            jobId: ingestionJob.ingestionJobId,
            status: ingestionJob.status,
          });
        }

        if (request.method === "GET" && pathname === "/job") {
          const jobId = url.searchParams.get("id") ?? "";
          const { ingestionJob } = yield* getIngestionJob({
            ingestionJobId: jobId,
          });
          return yield* HttpServerResponse.json({
            status: ingestionJob.status,
          });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const { ingestionJobSummaries } = yield* listIngestionJobs({});
          return yield* HttpServerResponse.json({
            count: ingestionJobSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/retrieve") {
          const result = yield* retrieve({
            retrievalQuery: { text: "What is Alchemy?" },
            retrievalConfiguration: {
              vectorSearchConfiguration: { numberOfResults: 3 },
            },
          });
          return yield* HttpServerResponse.json({
            count: result.retrievalResults.length,
            passages: result.retrievalResults.map((r) => r.content?.text),
          });
        }

        if (request.method === "GET" && pathname === "/rag-stream") {
          // knowledgeBaseId is an Accessor<string> at init scope — yield it
          // again at request time to resolve the concrete value.
          const kbId = yield* knowledgeBaseId;
          const result = yield* ragStream({
            input: { text: "What is Alchemy?" },
            retrieveAndGenerateConfiguration: {
              type: "KNOWLEDGE_BASE",
              knowledgeBaseConfiguration: {
                knowledgeBaseId: kbId,
                modelArn: MODEL,
              },
            },
          });
          const events = yield* Stream.runCollect(result.stream);
          const text = Array.from(events)
            .map((event) => event.output?.text ?? "")
            .join("");
          return yield* HttpServerResponse.json({
            sessionId: result.sessionId,
            events: events.length,
            text,
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
        Bedrock.DeleteKnowledgeBaseDocumentsHttp,
        Bedrock.GetIngestionJobHttp,
        Bedrock.GetKnowledgeBaseDocumentsHttp,
        Bedrock.IngestKnowledgeBaseDocumentsHttp,
        Bedrock.ListIngestionJobsHttp,
        Bedrock.ListKnowledgeBaseDocumentsHttp,
        Bedrock.RetrieveHttp,
        Bedrock.RetrieveAndGenerateStreamHttp,
        Bedrock.StartIngestionJobHttp,
      ),
    ),
  ),
);
