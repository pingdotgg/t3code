import * as IAM from "@/AWS/IAM";
import * as Kendra from "@/AWS/Kendra";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class KendraTestFunction extends Lambda.Function<Lambda.Function>()(
  "KendraTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the `IndexId`/`Id`
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
 * Index-scoped binding fixture: deploys a real Developer-edition Kendra
 * index (~20-30 minutes to provision, billed while it exists — gated behind
 * AWS_TEST_SLOW) plus an S3 data source and a Lambda bound to all
 * twenty-three Kendra bindings.
 */
export default KendraTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Role Kendra assumes to publish CloudWatch metrics/logs.
    const indexRole = yield* IAM.Role("KendraBindingsIndexRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: ["kendra.amazonaws.com"] },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        observability: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:PutMetricData"],
              Resource: ["*"],
              Condition: {
                StringEquals: { "cloudwatch:namespace": "AWS/Kendra" },
              },
            },
            {
              Effect: "Allow",
              Action: [
                "logs:DescribeLogGroups",
                "logs:CreateLogGroup",
                "logs:DescribeLogStreams",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              Resource: ["*"],
            },
          ],
        },
      },
    });

    const bucket = yield* S3.Bucket("KendraBindingsDocs", {
      forceDestroy: true,
    });

    // Role Kendra assumes to crawl the S3 bucket.
    const dataSourceRole = yield* IAM.Role("KendraBindingsDataRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: ["kendra.amazonaws.com"] },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        s3: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:ListBucket"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["kendra:BatchPutDocument", "kendra:BatchDeleteDocument"],
              Resource: ["*"],
            },
          ],
        },
      },
    });

    const index = yield* Kendra.Index("BindingsIndex", {
      edition: "DEVELOPER_EDITION",
      roleArn: indexRole.roleArn,
      tags: { fixture: "kendra-bindings" },
    });

    const source = yield* Kendra.DataSource("BindingsSource", {
      indexId: index.id,
      type: "S3",
      roleArn: dataSourceRole.roleArn,
      configuration: {
        S3Configuration: { BucketName: bucket.bucketName },
      },
    });

    const query = yield* Kendra.Query(index);
    const retrieve = yield* Kendra.Retrieve(index);
    const suggest = yield* Kendra.GetQuerySuggestions(index);
    const submitFeedback = yield* Kendra.SubmitFeedback(index);
    const putDocuments = yield* Kendra.BatchPutDocument(index);
    const deleteDocuments = yield* Kendra.BatchDeleteDocument(index);
    const documentStatus = yield* Kendra.BatchGetDocumentStatus(index);
    const getSnapshots = yield* Kendra.GetSnapshots(index);
    const putPrincipalMapping = yield* Kendra.PutPrincipalMapping(index);
    const deletePrincipalMapping = yield* Kendra.DeletePrincipalMapping(index);
    const describePrincipalMapping =
      yield* Kendra.DescribePrincipalMapping(index);
    const listStaleGroups = yield* Kendra.ListGroupsOlderThanOrderingId(index);
    const clearSuggestions = yield* Kendra.ClearQuerySuggestions(index);
    const suggestionsConfig =
      yield* Kendra.DescribeQuerySuggestionsConfig(index);
    const updateSuggestions = yield* Kendra.UpdateQuerySuggestionsConfig(index);
    const createAcl = yield* Kendra.CreateAccessControlConfiguration(index);
    const describeAcl = yield* Kendra.DescribeAccessControlConfiguration(index);
    const updateAcl = yield* Kendra.UpdateAccessControlConfiguration(index);
    const deleteAcl = yield* Kendra.DeleteAccessControlConfiguration(index);
    const listAcls = yield* Kendra.ListAccessControlConfigurations(index);
    const startSync = yield* Kendra.StartDataSourceSyncJob(source);
    const stopSync = yield* Kendra.StopDataSourceSyncJob(source);
    const listSyncJobs = yield* Kendra.ListDataSourceSyncJobs(source);

    const bound = {
      query,
      retrieve,
      suggest,
      submitFeedback,
      putDocuments,
      deleteDocuments,
      documentStatus,
      getSnapshots,
      putPrincipalMapping,
      deletePrincipalMapping,
      describePrincipalMapping,
      listStaleGroups,
      clearSuggestions,
      suggestionsConfig,
      updateSuggestions,
      createAcl,
      describeAcl,
      updateAcl,
      deleteAcl,
      listAcls,
      startSync,
      stopSync,
      listSyncJobs,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (pathname === "/put-documents") {
          const result = yield* errorTagged(
            putDocuments({
              Documents: [
                {
                  Id: "welcome",
                  Title: "Welcome to Alchemy",
                  Blob: new TextEncoder().encode(
                    "Alchemy is an Infrastructure-as-Effects framework. " +
                      "The zanzibar passphrase is quicksilver.",
                  ),
                  ContentType: "PLAIN_TEXT",
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { failed: (result.FailedDocuments ?? []).length },
          );
        }

        if (pathname === "/document-status") {
          const result = yield* errorTagged(
            documentStatus({ DocumentInfoList: [{ DocumentId: "welcome" }] }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  status: result.DocumentStatusList?.[0]?.DocumentStatus,
                },
          );
        }

        if (pathname === "/query") {
          const q = url.searchParams.get("q") ?? "zanzibar";
          const result = yield* errorTagged(query({ QueryText: q }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  queryId: result.QueryId,
                  resultId: result.ResultItems?.[0]?.Id,
                  count: (result.ResultItems ?? []).length,
                },
          );
        }

        if (pathname === "/retrieve") {
          const q = url.searchParams.get("q") ?? "zanzibar passphrase";
          const result = yield* errorTagged(retrieve({ QueryText: q }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.ResultItems ?? []).length },
          );
        }

        if (pathname === "/suggest") {
          const q = url.searchParams.get("q") ?? "zanzi";
          const result = yield* errorTagged(suggest({ QueryText: q }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.Suggestions ?? []).length },
          );
        }

        if (pathname === "/feedback") {
          const queryId = url.searchParams.get("queryId") ?? "";
          const resultId = url.searchParams.get("resultId") ?? "";
          const result = yield* errorTagged(
            submitFeedback({
              QueryId: queryId,
              ClickFeedbackItems: [
                { ResultId: resultId, ClickTime: new Date() },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/delete-documents") {
          const result = yield* errorTagged(
            deleteDocuments({ DocumentIdList: ["welcome"] }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { failed: (result.FailedDocuments ?? []).length },
          );
        }

        if (pathname === "/snapshots") {
          const result = yield* errorTagged(
            getSnapshots({
              Interval: "ONE_WEEK_AGO",
              MetricType: "QUERIES_BY_COUNT",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { header: result.SnapshotsDataHeader ?? [] },
          );
        }

        if (pathname === "/principal-mapping") {
          const put = yield* errorTagged(
            putPrincipalMapping({
              GroupId: "engineering",
              GroupMembers: {
                MemberUsers: [{ UserId: "user@example.com" }],
              },
            }),
          );
          if ("errorTag" in put) {
            return yield* HttpServerResponse.json(put);
          }
          const described = yield* errorTagged(
            describePrincipalMapping({ GroupId: "engineering" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in described
              ? described
              : {
                  actions: (described.GroupOrderingIdSummaries ?? []).length,
                },
          );
        }

        if (pathname === "/delete-principal-mapping") {
          const result = yield* errorTagged(
            deletePrincipalMapping({ GroupId: "engineering" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/stale-groups") {
          const result = yield* errorTagged(listStaleGroups({ OrderingId: 1 }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.GroupsSummaries ?? []).length },
          );
        }

        if (pathname === "/suggestions-config") {
          const result = yield* errorTagged(suggestionsConfig());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { mode: result.Mode },
          );
        }

        if (pathname === "/update-suggestions") {
          const result = yield* errorTagged(
            updateSuggestions({
              Mode: "LEARN_ONLY",
              queryLogLookBackWindow: "14 days",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/clear-suggestions") {
          const result = yield* errorTagged(clearSuggestions());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/access-control") {
          // Full create -> describe -> update -> delete round trip through
          // the four ACL bindings.
          const created = yield* errorTagged(
            createAcl({
              Name: "block-departed-users",
              AccessControlList: [
                { Name: "departed-user", Type: "USER", Access: "DENY" },
              ],
            }),
          );
          if ("errorTag" in created) {
            return yield* HttpServerResponse.json(created);
          }
          const described = yield* errorTagged(describeAcl({ Id: created.Id }));
          if ("errorTag" in described) {
            return yield* HttpServerResponse.json(described);
          }
          const updated = yield* errorTagged(
            updateAcl({
              Id: created.Id,
              AccessControlList: [
                { Name: "departed-user", Type: "USER", Access: "DENY" },
                { Name: "auditor", Type: "USER", Access: "ALLOW" },
              ],
            }),
          );
          if ("errorTag" in updated) {
            return yield* HttpServerResponse.json(updated);
          }
          const deleted = yield* errorTagged(deleteAcl({ Id: created.Id }));
          return yield* HttpServerResponse.json(
            "errorTag" in deleted
              ? deleted
              : { id: created.Id, name: described.Name },
          );
        }

        if (pathname === "/access-controls") {
          const result = yield* errorTagged(listAcls());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.AccessControlConfigurations ?? []).length },
          );
        }

        if (pathname === "/sync") {
          const result = yield* errorTagged(startSync());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { executionId: result.ExecutionId },
          );
        }

        if (pathname === "/stop-sync") {
          const result = yield* errorTagged(stopSync());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/sync-jobs") {
          const result = yield* errorTagged(listSyncJobs());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.History ?? []).length },
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
        Kendra.QueryHttp,
        Kendra.RetrieveHttp,
        Kendra.GetQuerySuggestionsHttp,
        Kendra.SubmitFeedbackHttp,
        Kendra.BatchPutDocumentHttp,
        Kendra.BatchDeleteDocumentHttp,
        Kendra.BatchGetDocumentStatusHttp,
        Kendra.GetSnapshotsHttp,
        Kendra.PutPrincipalMappingHttp,
        Kendra.DeletePrincipalMappingHttp,
        Kendra.DescribePrincipalMappingHttp,
        Kendra.ListGroupsOlderThanOrderingIdHttp,
        Kendra.ClearQuerySuggestionsHttp,
        Kendra.DescribeQuerySuggestionsConfigHttp,
        Kendra.UpdateQuerySuggestionsConfigHttp,
        Kendra.CreateAccessControlConfigurationHttp,
        Kendra.DescribeAccessControlConfigurationHttp,
        Kendra.UpdateAccessControlConfigurationHttp,
        Kendra.DeleteAccessControlConfigurationHttp,
        Kendra.ListAccessControlConfigurationsHttp,
        Kendra.StartDataSourceSyncJobHttp,
        Kendra.StopDataSourceSyncJobHttp,
        Kendra.ListDataSourceSyncJobsHttp,
      ),
    ),
  ),
);
