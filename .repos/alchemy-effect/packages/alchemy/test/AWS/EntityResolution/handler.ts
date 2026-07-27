import * as EntityResolution from "@/AWS/EntityResolution";
import * as Glue from "@/AWS/Glue";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic fixture names (bucket names are account-global; this suite
// owns them in the testing account).
export const FIXTURE_BUCKET_NAME = "alchemy-test-entityres-bindings";

// Well-formed-but-nonexistent job id used to drive the typed
// ResourceNotFoundException paths. An IAM gap would surface
// AccessDeniedException (a 500 through the handler's orDie), so a typed
// not-found tag proves the grant end-to-end.
const BOGUS_JOB_ID = "00000000000000000000000000000000";

export class EntityResolutionTestFunction extends Lambda.Function<Lambda.Function>()(
  "EntityResolutionTestFunction",
) {}

export default EntityResolutionTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("ErBindingsBucket", {
      bucketName: FIXTURE_BUCKET_NAME,
      forceDestroy: true,
    });
    // The role Entity Resolution assumes to read the Glue input tables (and
    // their underlying S3 data) and write matched output to S3.
    const role = yield* IAM.Role("ErBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "entityresolution.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        workflow: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "glue:GetDatabase",
                "glue:GetTable",
                "glue:GetPartition",
                "glue:GetPartitions",
                "glue:GetSchema",
                "glue:GetSchemaVersion",
              ],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
              Resource: [
                `arn:aws:s3:::${FIXTURE_BUCKET_NAME}`,
                `arn:aws:s3:::${FIXTURE_BUCKET_NAME}/*`,
              ],
            },
          ],
        },
      },
    });
    const database = yield* Glue.Database("ErBindingsDb", {});
    const table = yield* Glue.Table("Customers", {
      databaseName: database.databaseName,
      storageDescriptor: {
        location: `s3://${FIXTURE_BUCKET_NAME}/input/`,
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat:
          "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: {
          serializationLibrary:
            "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
          parameters: { "field.delim": ",", "skip.header.line.count": "1" },
        },
        columns: [
          { name: "id", type: "string" },
          { name: "email", type: "string" },
          { name: "name", type: "string" },
        ],
      },
      parameters: { classification: "csv" },
    });
    const schema = yield* EntityResolution.SchemaMapping("ErBindingsSchema", {
      mappedInputFields: [
        { fieldName: "id", type: "UNIQUE_ID" },
        { fieldName: "email", type: "EMAIL_ADDRESS", matchKey: "email" },
        { fieldName: "name", type: "NAME", matchKey: "name" },
      ],
    });
    const matchingWorkflow = yield* EntityResolution.MatchingWorkflow(
      "ErBindingsMatching",
      {
        inputSourceConfig: [
          { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
        ],
        outputSourceConfig: [
          {
            outputS3Path: `s3://${FIXTURE_BUCKET_NAME}/matches/`,
            output: [{ name: "id" }, { name: "email" }, { name: "name" }],
          },
        ],
        resolutionTechniques: {
          resolutionType: "RULE_MATCHING",
          ruleBasedProperties: {
            rules: [{ ruleName: "ByEmail", matchingKeys: ["email"] }],
            attributeMatchingModel: "ONE_TO_ONE",
          },
        },
        roleArn: role.roleArn,
      },
    );

    // Rule-based ID mapping: SOURCE and TARGET namespaces over the same Glue
    // table, with the matching rules declared on the TARGET namespace.
    const sourceNamespace = yield* EntityResolution.IdNamespace(
      "ErBindingsSourceNs",
      {
        type: "SOURCE",
        inputSourceConfig: [
          { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
        ],
        // The workflow-create validation requires the SOURCE namespace to
        // declare its rule-based capabilities (rules themselves live on the
        // TARGET namespace).
        idMappingWorkflowProperties: [
          {
            idMappingType: "RULE_BASED",
            ruleBasedProperties: {
              ruleDefinitionTypes: ["TARGET"],
              attributeMatchingModel: "ONE_TO_ONE",
              recordMatchingModels: ["ONE_SOURCE_TO_ONE_TARGET"],
            },
          },
        ],
        roleArn: role.roleArn,
      },
    );
    // The service requires TARGET namespace input sources to be matching
    // workflow ARNs (the target ids are the workflow's match IDs):
    // "Check that it follows the pattern:
    //  arn:(aws|...):entityresolution:...:matchingworkflow/{resource_name}".
    const targetNamespace = yield* EntityResolution.IdNamespace(
      "ErBindingsTargetNs",
      {
        type: "TARGET",
        inputSourceConfig: [{ inputSourceARN: matchingWorkflow.workflowArn }],
        idMappingWorkflowProperties: [
          {
            idMappingType: "RULE_BASED",
            ruleBasedProperties: {
              rules: [{ ruleName: "ByEmail", matchingKeys: ["email"] }],
              ruleDefinitionTypes: ["TARGET"],
              attributeMatchingModel: "ONE_TO_ONE",
              recordMatchingModels: ["ONE_SOURCE_TO_ONE_TARGET"],
            },
          },
        ],
        roleArn: role.roleArn,
      },
    );
    const idMappingWorkflow = yield* EntityResolution.IdMappingWorkflow(
      "ErBindingsIdMapping",
      {
        inputSourceConfig: [
          {
            inputSourceARN: sourceNamespace.idNamespaceArn,
            type: "SOURCE",
          },
          {
            inputSourceARN: targetNamespace.idNamespaceArn,
            type: "TARGET",
          },
        ],
        idMappingTechniques: {
          idMappingType: "RULE_BASED",
          ruleBasedProperties: {
            ruleDefinitionType: "TARGET",
            attributeMatchingModel: "ONE_TO_ONE",
            recordMatchingModel: "ONE_SOURCE_TO_ONE_TARGET",
          },
        },
        outputSourceConfig: [
          { outputS3Path: `s3://${FIXTURE_BUCKET_NAME}/idmapping/` },
        ],
        roleArn: role.roleArn,
      },
    );

    // Used by the real-time routes: records reference the Glue table ARN.
    const tableArn = yield* table.tableArn;

    // --- matching workflow bindings ---
    const startMatchingJob =
      yield* EntityResolution.StartMatchingJob(matchingWorkflow);
    const getMatchingJob =
      yield* EntityResolution.GetMatchingJob(matchingWorkflow);
    const listMatchingJobs =
      yield* EntityResolution.ListMatchingJobs(matchingWorkflow);
    const generateMatchId =
      yield* EntityResolution.GenerateMatchId(matchingWorkflow);
    const getMatchId = yield* EntityResolution.GetMatchId(matchingWorkflow);
    const batchDeleteUniqueId =
      yield* EntityResolution.BatchDeleteUniqueId(matchingWorkflow);

    // --- id mapping workflow bindings ---
    const startIdMappingJob =
      yield* EntityResolution.StartIdMappingJob(idMappingWorkflow);
    const getIdMappingJob =
      yield* EntityResolution.GetIdMappingJob(idMappingWorkflow);
    const listIdMappingJobs =
      yield* EntityResolution.ListIdMappingJobs(idMappingWorkflow);

    const bound = {
      startMatchingJob,
      getMatchingJob,
      listMatchingJobs,
      generateMatchId,
      getMatchId,
      batchDeleteUniqueId,
      startIdMappingJob,
      getIdMappingJob,
      listIdMappingJobs,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Entity Resolution call.
        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Workflow-scoped job listings (both empty on a fresh deploy).
        if (request.method === "GET" && pathname === "/jobs") {
          const matching = yield* listMatchingJobs({});
          const idMapping = yield* listIdMappingJobs({});
          return yield* HttpServerResponse.json({
            matchingJobs: (matching.jobs ?? []).length,
            idMappingJobs: (idMapping.jobs ?? []).length,
          });
        }

        // Drives GetMatchingJob + GetIdMappingJob through their typed
        // ResourceNotFoundException path (an IAM gap would be a 500).
        if (request.method === "GET" && pathname === "/jobs/not-found") {
          const matching = yield* getMatchingJob({ jobId: BOGUS_JOB_ID }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const idMapping = yield* getIdMappingJob({
            jobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ matching, idMapping });
        }

        // Real-time lookup of a record that has never been processed — a
        // successful empty response proves the grant + request plumbing.
        if (request.method === "POST" && pathname === "/match-id") {
          const response = yield* getMatchId({
            record: { id: "1", email: "jane@example.com", name: "Jane Doe" },
          }).pipe(
            Effect.map((r) => ({
              result: "ok" as const,
              matchId: r.matchId ?? null,
              matchRule: r.matchRule ?? null,
              message: null as string | null,
            })),
            // A workflow that has never run a job may reject real-time
            // lookups — surface the typed rejection so the test can assert
            // on it (an IAM gap would still be a 500).
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) =>
                Effect.succeed({
                  result: e._tag as string,
                  matchId: null,
                  matchRule: null,
                  message: e.message ?? null,
                }),
            ),
          );
          return yield* HttpServerResponse.json(response);
        }

        // Real-time match-id generation for two records that match by email.
        if (request.method === "POST" && pathname === "/generate-match-id") {
          const result = yield* generateMatchId({
            records: [
              {
                inputSourceARN: yield* tableArn,
                uniqueId: "1",
                recordAttributeMap: {
                  id: "1",
                  email: "jane@example.com",
                  name: "Jane Doe",
                },
              },
              {
                inputSourceARN: yield* tableArn,
                uniqueId: "2",
                recordAttributeMap: {
                  id: "2",
                  email: "jane@example.com",
                  name: "Jane D",
                },
              },
            ],
          }).pipe(
            Effect.map((r) => ({
              result: "ok" as const,
              matchGroups: r.matchGroups.length,
              failedRecords: r.failedRecords.length,
            })),
            // Real-time generation requires the workflow family to support
            // it — surface the typed rejection instead of a 500 so the test
            // can assert on it.
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) =>
                Effect.succeed({
                  result: e._tag as string,
                  message: e.message ?? null,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Deletes unknown unique ids from the match store — per-id errors
        // (or a typed ValidationException when the workflow family doesn't
        // support deletes) prove the grant end-to-end.
        if (request.method === "POST" && pathname === "/delete-unique-ids") {
          // Fully total: report ANY typed failure as its tag so the test can
          // assert on the observed behavior (an IAM gap would surface here as
          // AccessDeniedException rather than an opaque 500).
          const outcome = yield* batchDeleteUniqueId({
            uniqueIds: ["ghost-1", "ghost-2"],
          }).pipe(Effect.result);
          const result =
            outcome._tag === "Success"
              ? {
                  result: "ok" as const,
                  status: outcome.success.status,
                  deleted: (outcome.success.deleted ?? []).length,
                  errors: (outcome.success.errors ?? []).length,
                  disconnected: (outcome.success.disconnectedUniqueIds ?? [])
                    .length,
                }
              : {
                  result: outcome.failure._tag as string,
                  message: String(outcome.failure),
                };
          return yield* HttpServerResponse.json(result);
        }

        // Gated by the test: really starts batch jobs (matching runs take
        // many minutes and cannot be cancelled — only exercised when
        // AWS_TEST_ENTITYRESOLUTION_RUN is set).
        if (request.method === "POST" && pathname === "/start-matching-job") {
          const { jobId } = yield* startMatchingJob({});
          const job = yield* getMatchingJob({ jobId });
          return yield* HttpServerResponse.json({
            jobId,
            status: job.status,
          });
        }
        if (request.method === "POST" && pathname === "/start-id-mapping-job") {
          const { jobId } = yield* startIdMappingJob({});
          const job = yield* getIdMappingJob({ jobId });
          return yield* HttpServerResponse.json({
            jobId,
            status: job.status,
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
        EntityResolution.StartMatchingJobHttp,
        EntityResolution.GetMatchingJobHttp,
        EntityResolution.ListMatchingJobsHttp,
        EntityResolution.GenerateMatchIdHttp,
        EntityResolution.GetMatchIdHttp,
        EntityResolution.BatchDeleteUniqueIdHttp,
        EntityResolution.StartIdMappingJobHttp,
        EntityResolution.GetIdMappingJobHttp,
        EntityResolution.ListIdMappingJobsHttp,
      ),
    ),
  ),
);
