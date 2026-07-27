import * as AWS from "@/AWS";
import { DataSource, KnowledgeBase } from "@/AWS/Bedrock";
import * as S3 from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import BedrockKbTestFunctionLive, { BedrockKbTestFunction } from "./kb-handler";

const { test } = Test.make({ providers: AWS.providers() });

// The KnowledgeBase + DataSource live lifecycle needs a pre-existing vector
// store. Provisioning an OpenSearch Serverless collection is cheap, but the
// vector INDEX must be created through the collection's data-plane API
// (SigV4-signed HTTP to the collection endpoint) — there is no AWS control
// -plane call for it — which is out of scope for this suite. Supply a ready
// collection + index (and a KB service role that can read the embedding model,
// the collection, and S3) via env vars to run this against real infra.
//
//   AWS_TEST_SLOW=1
//   BEDROCK_KB_ROLE_ARN=arn:aws:iam::...:role/...
//   BEDROCK_KB_COLLECTION_ARN=arn:aws:aoss:...:collection/...
//   BEDROCK_KB_INDEX_NAME=bedrock-index
//   BEDROCK_KB_EMBEDDING_MODEL_ARN=arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0
const roleArn = process.env.BEDROCK_KB_ROLE_ARN;
const collectionArn = process.env.BEDROCK_KB_COLLECTION_ARN;
const indexName = process.env.BEDROCK_KB_INDEX_NAME ?? "bedrock-index";
const embeddingModelArn = process.env.BEDROCK_KB_EMBEDDING_MODEL_ARN;

const gated =
  !process.env.AWS_TEST_SLOW ||
  !roleArn ||
  !collectionArn ||
  !embeddingModelArn;

const findKb = (knowledgeBaseId: string) =>
  bedrock.getKnowledgeBase({ knowledgeBaseId }).pipe(
    Effect.map((r) => r.knowledgeBase),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class StillExists extends Data.TaggedError("StillExists")<{
  readonly id: string;
}> {}

const assertKbGone = (knowledgeBaseId: string) =>
  findKb(knowledgeBaseId).pipe(
    Effect.flatMap((kb) =>
      kb === undefined || kb.status === "DELETING"
        ? Effect.void
        : Effect.fail(new StillExists({ id: knowledgeBaseId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([Schedule.exponential(2000), Schedule.recurs(10)]),
    }),
  );

test.provider.skipIf(gated)(
  "create knowledge base + S3 data source, then delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* S3.Bucket("kb-docs", { forceDestroy: true });
          const kb = yield* KnowledgeBase("TestKb", {
            roleArn: roleArn!,
            knowledgeBaseConfiguration: {
              type: "VECTOR",
              vectorKnowledgeBaseConfiguration: {
                embeddingModelArn: embeddingModelArn!,
              },
            },
            storageConfiguration: {
              type: "OPENSEARCH_SERVERLESS",
              opensearchServerlessConfiguration: {
                collectionArn: collectionArn!,
                vectorIndexName: indexName,
                fieldMapping: {
                  vectorField: "bedrock-vector",
                  textField: "bedrock-text",
                  metadataField: "bedrock-metadata",
                },
              },
            },
            tags: { Environment: "test" },
          });
          const source = yield* DataSource("TestSource", {
            knowledgeBaseId: kb.knowledgeBaseId,
            dataSourceConfiguration: {
              type: "S3",
              s3Configuration: { bucketArn: bucket.bucketArn },
            },
            dataDeletionPolicy: "DELETE",
          });
          return {
            knowledgeBaseId: kb.knowledgeBaseId,
            knowledgeBaseArn: kb.knowledgeBaseArn,
            dataSourceId: source.dataSourceId,
          };
        }),
      );

      const kb = yield* findKb(result.knowledgeBaseId);
      expect(kb?.status).toBe("ACTIVE");

      const ds = yield* bedrock
        .getDataSource({
          knowledgeBaseId: result.knowledgeBaseId,
          dataSourceId: result.dataSourceId,
        })
        .pipe(Effect.map((r) => r.dataSource));
      expect(ds.status).toBe("AVAILABLE");

      yield* stack.destroy();
      yield* assertKbGone(result.knowledgeBaseId);
    }),
  { timeout: 600_000 },
);

// Runtime coverage for the KB-scoped bindings (document ingestion, ingestion
// jobs, retrieve, streaming RAG) through a deployed Lambda — gated behind the
// same vector-store env prerequisites as the lifecycle test above.
test.provider.skipIf(gated)(
  "KB-scoped bindings work from a deployed Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* BedrockKbTestFunction;
        }).pipe(Effect.provide(BedrockKbTestFunctionLive)),
      );
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // Fresh function URLs take a few seconds to start serving 200s.
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((r) =>
          r.status === 200
            ? Effect.succeed(r)
            : Effect.fail(new Error(`not ready: ${r.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );

      const getJson = (path: string) =>
        HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
      const postJson = (path: string) =>
        HttpClient.post(`${baseUrl}${path}`).pipe(
          Effect.flatMap((r) => r.json),
        );

      // 1. Direct document ingestion into the CUSTOM data source.
      const ingested = (yield* postJson("/ingest")) as { status?: string };
      expect(ingested.status).toBeDefined();

      // 2. Poll the document to INDEXED.
      const docStatus = (yield* getJson("/doc-status").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (r): boolean =>
            (r as { status?: string }).status === "INDEXED" ||
            (r as { status?: string }).status === "FAILED",
          times: 36,
        }),
      )) as { status?: string };
      expect(docStatus.status).toBe("INDEXED");

      // 3. The document is tracked.
      const docs = (yield* getJson("/docs")) as { count: number };
      expect(docs.count).toBeGreaterThan(0);

      // 4. Semantic retrieval finds the ingested passage.
      const retrieved = (yield* getJson("/retrieve").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (r): boolean => (r as { count: number }).count > 0,
          times: 12,
        }),
      )) as { count: number; passages: string[] };
      expect(retrieved.count).toBeGreaterThan(0);

      // 5. Streaming RAG produces a grounded, non-empty answer.
      const rag = (yield* getJson("/rag-stream")) as {
        events: number;
        text: string;
      };
      expect(rag.events).toBeGreaterThan(0);
      expect(rag.text.trim().length).toBeGreaterThan(0);

      // 6. Ingestion-job lifecycle on the S3 data source.
      const sync = (yield* postJson("/sync")) as { jobId: string };
      expect(sync.jobId).toBeDefined();
      const job = (yield* getJson(`/job?id=${sync.jobId}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (r): boolean =>
            (r as { status: string }).status === "COMPLETE" ||
            (r as { status: string }).status === "FAILED",
          times: 36,
        }),
      )) as { status: string };
      expect(job.status).toBe("COMPLETE");
      const jobs = (yield* getJson("/jobs")) as { count: number };
      expect(jobs.count).toBeGreaterThan(0);

      // 7. Delete the document again.
      const deleted = (yield* postJson("/delete-doc")) as { status?: string };
      expect(deleted.status).toBeDefined();

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
