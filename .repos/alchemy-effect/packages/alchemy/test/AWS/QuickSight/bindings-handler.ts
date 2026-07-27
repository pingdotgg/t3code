import * as Lambda from "@/AWS/Lambda";
import * as QuickSight from "@/AWS/QuickSight";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

export class QuickSightBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "QuickSightBindingsFunction",
) {}

export default QuickSightBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const source = yield* QuickSight.DataSource("BindingsSource", {
      name: "Alchemy QuickSight Bindings Source",
      type: "ATHENA",
      dataSourceParameters: { AthenaParameters: { WorkGroup: "primary" } },
    });

    const dataSet = yield* QuickSight.DataSet("BindingsDataSet", {
      name: "Alchemy QuickSight Bindings DataSet",
      importMode: "DIRECT_QUERY",
      physicalTableMap: {
        probe: {
          CustomSql: {
            DataSourceArn: source.arn,
            Name: "probe",
            SqlQuery: "SELECT 1 AS n",
            Columns: [{ Name: "n", Type: "INTEGER" }],
          },
        },
      },
    });

    const dashboard = yield* QuickSight.Dashboard("BindingsDashboard", {
      name: "Alchemy QuickSight Bindings Dashboard",
      definition: {
        DataSetIdentifierDeclarations: [
          { Identifier: "probe", DataSetArn: dataSet.arn },
        ],
        Sheets: [{ SheetId: "sheet1", Name: "Sheet 1" }],
      },
    });

    const createIngestion = yield* QuickSight.CreateIngestion(dataSet);
    const describeIngestion = yield* QuickSight.DescribeIngestion(dataSet);
    const cancelIngestion = yield* QuickSight.CancelIngestion(dataSet);
    const listIngestions = yield* QuickSight.ListIngestions(dataSet);
    const startSnapshotJob =
      yield* QuickSight.StartDashboardSnapshotJob(dashboard);
    const describeSnapshotJob =
      yield* QuickSight.DescribeDashboardSnapshotJob(dashboard);
    const describeSnapshotJobResult =
      yield* QuickSight.DescribeDashboardSnapshotJobResult(dashboard);
    const generateEmbedUrlForRegisteredUser =
      yield* QuickSight.GenerateEmbedUrlForRegisteredUser(dashboard);
    const generateEmbedUrlForAnonymousUser =
      yield* QuickSight.GenerateEmbedUrlForAnonymousUser(dashboard);

    const bound = {
      createIngestion,
      describeIngestion,
      cancelIngestion,
      listIngestions,
      startSnapshotJob,
      describeSnapshotJob,
      describeSnapshotJobResult,
      generateEmbedUrlForRegisteredUser,
      generateEmbedUrlForAnonymousUser,
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

        if (request.method === "GET" && pathname === "/ingestions") {
          // DataSetId + AwsAccountId injection scope the call to the bound
          // dataset.
          const response = yield* listIngestions({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            count: (response.Ingestions ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/ingestion") {
          // A DIRECT_QUERY dataset cannot be ingested into SPICE — the typed
          // 400 proves the CreateIngestion grant + id injection end-to-end
          // without mutating anything. An IAM gap would surface
          // AccessDeniedException instead.
          const ingestionId = yield* Effect.sync(() => crypto.randomUUID());
          const created = yield* createIngestion({
            IngestionId: ingestionId,
            IngestionType: "FULL_REFRESH",
          }).pipe(
            Effect.map((r) => ({ started: true as const, id: r.IngestionId })),
            Effect.catchTag(
              ["InvalidParameterValueException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ started: false as const, error: e._tag }),
            ),
          );
          if (!created.started) {
            return yield* HttpServerResponse.json(created);
          }
          // SPICE dataset path: observe then cancel the refresh.
          const status = yield* describeIngestion({
            IngestionId: ingestionId,
          }).pipe(
            Effect.map((r) => r.Ingestion?.IngestionStatus),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          yield* cancelIngestion({ IngestionId: ingestionId }).pipe(
            Effect.catchTag(
              ["InvalidParameterValueException", "ResourceNotFoundException"],
              () => Effect.void,
            ),
          );
          return yield* HttpServerResponse.json({ ...created, status });
        }

        if (
          request.method === "GET" &&
          pathname === "/snapshot-job/typed-not-found"
        ) {
          // Both describe ops on a nonexistent job id surface the typed
          // not-found, proving grant + DashboardId injection.
          const describe = yield* describeSnapshotJob({
            SnapshotJobId: "alchemy-nonexistent-snapshot-job",
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          const result = yield* describeSnapshotJobResult({
            SnapshotJobId: "alchemy-nonexistent-snapshot-job",
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterValueException"],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ describe, result });
        }

        if (request.method === "POST" && pathname === "/snapshot-job") {
          // Snapshot export requires paginated-report entitlement on some
          // accounts; either a started job or the typed rejection proves the
          // grant.
          const jobId = yield* Effect.sync(() => crypto.randomUUID());
          const outcome = yield* startSnapshotJob({
            SnapshotJobId: jobId,
            UserConfiguration: { AnonymousUsers: [] },
            SnapshotConfiguration: {
              FileGroups: [
                {
                  Files: [
                    {
                      FormatType: "PDF",
                      SheetSelections: [
                        { SheetId: "sheet1", SelectionScope: "ALL_VISUALS" },
                      ],
                    },
                  ],
                },
              ],
            },
          }).pipe(
            Effect.map((r) => ({ started: true, jobId: r.SnapshotJobId })),
            Effect.catchTag(
              [
                "InvalidParameterValueException",
                "UnsupportedPricingPlanException",
                "UnsupportedUserEditionException",
                "LimitExceededException",
              ],
              (e) => Effect.succeed({ started: false, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        if (request.method === "GET" && pathname === "/embed-url") {
          // A nonexistent user arn surfaces the typed user-not-found — the
          // request reached the account-scoped embed API with the injected
          // AwsAccountId.
          const typed = yield* generateEmbedUrlForRegisteredUser({
            UserArn: url.searchParams.get("userArn") ?? "arn:invalid",
          }).pipe(
            Effect.map(() => "EmbedUrl"),
            Effect.catchTag(
              [
                "QuickSightUserNotFoundException",
                "ResourceNotFoundException",
                "InvalidParameterValueException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "GET" && pathname === "/embed-url-anon") {
          // Anonymous embedding needs session-capacity pricing; either the
          // URL or the typed pricing-plan rejection proves the grant.
          const outcome = yield* generateEmbedUrlForAnonymousUser().pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              [
                "UnsupportedPricingPlanException",
                "SessionLifetimeInMinutesInvalidException",
                "InvalidParameterValueException",
              ],
              (e) => Effect.succeed({ ok: false as const, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
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
        QuickSight.CreateIngestionHttp,
        QuickSight.DescribeIngestionHttp,
        QuickSight.CancelIngestionHttp,
        QuickSight.ListIngestionsHttp,
        QuickSight.StartDashboardSnapshotJobHttp,
        QuickSight.DescribeDashboardSnapshotJobHttp,
        QuickSight.DescribeDashboardSnapshotJobResultHttp,
        QuickSight.GenerateEmbedUrlForRegisteredUserHttp,
        QuickSight.GenerateEmbedUrlForAnonymousUserHttp,
      ),
    ),
  ),
);
