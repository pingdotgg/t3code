import * as ApplicationAutoScaling from "@/AWS/ApplicationAutoScaling";
import { Table } from "@/AWS/DynamoDB";
import * as Lambda from "@/AWS/Lambda";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// The freshly attached IAM policy can take tens of seconds to propagate to
// the Application Auto Scaling endpoint after the fixture deploys — retry the
// typed AccessDeniedException on a short bounded schedule (~30s total).
const retryWhileIamPropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e): boolean => e._tag === "AccessDeniedException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

export class ApplicationAutoScalingTestFunction extends Lambda.Function<Lambda.Function>()(
  "ApplicationAutoScalingTestFunction",
) {}

export default ApplicationAutoScalingTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // A provisioned DynamoDB table is the cheapest, fastest real scalable
    // resource (near-instant, free at 1 RCU/WCU).
    const table = yield* Table("BindingsTable", {
      partitionKey: "id",
      attributes: { id: "S" },
      billingMode: "PROVISIONED",
      provisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    });
    const target = yield* ApplicationAutoScaling.ScalableTarget(
      "BindingsTarget",
      {
        serviceNamespace: "dynamodb",
        resourceId: Output.interpolate`table/${table.tableName}`,
        scalableDimension: "dynamodb:table:ReadCapacityUnits",
        minCapacity: 1,
        maxCapacity: 5,
      },
    );
    const policy = yield* ApplicationAutoScaling.ScalingPolicy(
      "BindingsPolicy",
      {
        serviceNamespace: target.serviceNamespace,
        resourceId: target.resourceId,
        scalableDimension: target.scalableDimension,
        targetTracking: {
          TargetValue: 70,
          PredefinedMetricSpecification: {
            PredefinedMetricType: "DynamoDBReadCapacityUtilization",
          },
        },
      },
    );

    const describeScalingActivities =
      yield* ApplicationAutoScaling.DescribeScalingActivities(target);
    const getPredictiveScalingForecast =
      yield* ApplicationAutoScaling.GetPredictiveScalingForecast(policy);

    // Subscribe to scaling-activity state-change (scaled-to-max) events —
    // creates the EventBridge rule + Lambda permission at deploy time.
    yield* ApplicationAutoScaling.consumeScalingActivityEvents(
      target,
      {},
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `${event["detail-type"]}: ${event.detail.resourceId} scaledToMax=${event.detail.scaledToMax}`,
          ),
        ),
    );

    const bound = {
      describeScalingActivities,
      getPredictiveScalingForecast,
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

        if (request.method === "GET" && pathname === "/scaling-activities") {
          const result = yield* retryWhileIamPropagates(
            describeScalingActivities({
              MaxResults: 25,
              IncludeNotScaledActivities: true,
            }),
          );
          return yield* HttpServerResponse.json({
            count: (result.ScalingActivities ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/forecast") {
          // Predictive scaling exists only for ECS services — for a
          // dynamodb-namespace target the live API PERMANENTLY rejects the
          // read with AccessDeniedException "GetPredictiveScalingForecast
          // is not supported.", which the distilled patch specializes into
          // the typed PredictiveScalingForecastNotSupported. Do NOT retry
          // it (it is not an IAM-propagation denial — retrying blows the
          // Lambda timeout and surfaces as an opaque 502). Return the
          // typed tag so the test proves the grant, the PolicyName
          // injection, and the typed error union end-to-end.
          const now = yield* Effect.sync(() => Date.now());
          const tag = yield* getPredictiveScalingForecast({
            StartTime: new Date(now),
            EndTime: new Date(now + 2 * 60 * 60 * 1000),
          }).pipe(
            Effect.map(() => "Forecast"),
            Effect.catchTag("PredictiveScalingForecastNotSupported", (e) =>
              Effect.succeed(e._tag),
            ),
            // Return whatever typed tag the API produced so an unexpected
            // error is observable in the test's assertion message instead
            // of an opaque 500. (The deployed bundle resolves distilled via
            // its built `lib/`, so until the coordinator rebuilds distilled
            // the platform rejection still surfaces as the base
            // AccessDeniedException tag in-Lambda.)
            Effect.catch((e) => Effect.succeed(e._tag)),
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
        ApplicationAutoScaling.DescribeScalingActivitiesHttp,
        ApplicationAutoScaling.GetPredictiveScalingForecastHttp,
      ),
    ),
  ),
);
