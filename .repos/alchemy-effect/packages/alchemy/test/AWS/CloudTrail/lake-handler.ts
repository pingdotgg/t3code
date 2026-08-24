import * as CloudTrail from "@/AWS/CloudTrail";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "lake-handler.ts");

/**
 * Probe helper: run the bound operation and report either the success
 * projection or the typed error tag, so the test can assert that operations
 * rejected by CloudTrail fail with a TYPED tag (never an untyped catch-all).
 */
const tagOr = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Record<string, unknown>,
) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isSuccess(result)
        ? onSuccess(result.success)
        : { errorTag: result.failure._tag },
    ),
  );

export class CloudTrailLakeTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudTrailLakeTestFunction",
) {}

export default CloudTrailLakeTestFunction.make(
  {
    main,
    url: true,
    // A fresh store settles through CREATED/STARTING_INGESTION before the
    // first query is accepted; the /query/run retry must fit the invocation.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // GATED FIXTURE: deploying this requires a CloudTrail-Lake-onboarded
    // account (Lake is closed to new customers — see the typed
    // CloudTrailLakeOnboardingClosed probe in EventDataStore.test.ts).
    const store = yield* CloudTrail.EventDataStore("BindingsLake", {
      multiRegionEnabled: false,
      retentionPeriod: "7 days",
      terminationProtectionEnabled: false,
    });

    const startQuery = yield* CloudTrail.StartQuery(store);
    const describeQuery = yield* CloudTrail.DescribeQuery(store);
    const getQueryResults = yield* CloudTrail.GetQueryResults(store);
    const cancelQuery = yield* CloudTrail.CancelQuery(store);
    const listQueries = yield* CloudTrail.ListQueries(store);
    const generateQuery = yield* CloudTrail.GenerateQuery(store);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        // Start a Lake query; the QueryStatement callback receives the bound
        // store's ID for the FROM clause. Rides out the store's
        // CREATED/STARTING_INGESTION settling window with a bounded retry.
        if (request.method === "GET" && pathname === "/query/run") {
          const result = yield* startQuery({
            QueryStatement: (id) => `SELECT eventID FROM ${id} LIMIT 1`,
          }).pipe(
            Effect.retry({
              while: (e): boolean =>
                e._tag === "InactiveEventDataStoreException" ||
                e._tag === "EventDataStoreNotFoundException" ||
                e._tag === "MaxConcurrentQueriesException",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          );
          return yield* HttpServerResponse.json({ queryId: result.QueryId });
        }

        if (request.method === "GET" && pathname === "/query/describe") {
          const result = yield* describeQuery({ QueryId: param("id") });
          return yield* HttpServerResponse.json({
            status: result.QueryStatus,
          });
        }

        if (request.method === "GET" && pathname === "/query/results") {
          const result = yield* getQueryResults({ QueryId: param("id") });
          return yield* HttpServerResponse.json({
            status: result.QueryStatus,
            rows: (result.QueryResultRows ?? []).length,
          });
        }

        // Cancelling an already-finished query fails with the typed
        // InactiveQueryException — either outcome proves IAM + typed errors.
        if (request.method === "POST" && pathname === "/query/cancel") {
          return yield* HttpServerResponse.json(
            yield* tagOr(cancelQuery({ QueryId: param("id") }), (result) => ({
              status: result.QueryStatus,
            })),
          );
        }

        // The bound store is injected as the request's EventDataStore.
        if (request.method === "GET" && pathname === "/query/list") {
          const result = yield* listQueries({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            ids: (result.Queries ?? []).map((q) => q.QueryId),
          });
        }

        // Natural-language SQL generation may be region/entitlement gated —
        // a rejection must surface as a TYPED tag.
        if (request.method === "POST" && pathname === "/query/generate") {
          return yield* HttpServerResponse.json(
            yield* tagOr(
              generateQuery({
                Prompt: "How many events were recorded in the last day?",
              }),
              (result) => ({ statement: result.QueryStatement }),
            ),
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
        CloudTrail.StartQueryHttp,
        CloudTrail.DescribeQueryHttp,
        CloudTrail.GetQueryResultsHttp,
        CloudTrail.CancelQueryHttp,
        CloudTrail.ListQueriesHttp,
        CloudTrail.GenerateQueryHttp,
      ),
    ),
  ),
);
