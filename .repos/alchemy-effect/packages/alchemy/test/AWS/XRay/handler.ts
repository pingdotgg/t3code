import * as Lambda from "@/AWS/Lambda";
import * as XRay from "@/AWS/XRay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class XRayTestFunction extends Lambda.Function<Lambda.Function>()(
  "XRayTestFunction",
) {}

/** Collapse a typed API call to `"ok"` or its typed error tag. */
const outcome = <A, E extends { _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isFailure(result) ? result.failure._tag : "ok",
    ),
  );

export default XRayTestFunction.make(
  {
    main,
    url: true,
    // Active tracing: every sampled invocation of this function produces an
    // X-Ray trace whose service name is the function name.
    tracing: "Active",
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to X-Ray insight updates. The deploy
    // proves the EventBridge rule + invoke permission wiring.
    yield* XRay.consumeInsightEvents({ states: ["ACTIVE"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `xray insight: ${event.detail.InsightId} (${event.detail.State})`,
        ),
      ),
    );

    const getTraceSummaries = yield* XRay.GetTraceSummaries();
    const batchGetTraces = yield* XRay.BatchGetTraces();
    const putTraceSegments = yield* XRay.PutTraceSegments();
    const putTelemetryRecords = yield* XRay.PutTelemetryRecords();
    const getSamplingRules = yield* XRay.GetSamplingRules();
    const getSamplingTargets = yield* XRay.GetSamplingTargets();
    const getSamplingStatisticSummaries =
      yield* XRay.GetSamplingStatisticSummaries();
    const getServiceGraph = yield* XRay.GetServiceGraph();
    const getTraceGraph = yield* XRay.GetTraceGraph();
    const getTimeSeriesServiceStatistics =
      yield* XRay.GetTimeSeriesServiceStatistics();
    const getInsight = yield* XRay.GetInsight();
    const getInsightEvents = yield* XRay.GetInsightEvents();
    const getInsightImpactGraph = yield* XRay.GetInsightImpactGraph();
    const getInsightSummaries = yield* XRay.GetInsightSummaries();
    const getTraceSegmentDestination = yield* XRay.GetTraceSegmentDestination();
    const startTraceRetrieval = yield* XRay.StartTraceRetrieval();
    const listRetrievedTraces = yield* XRay.ListRetrievedTraces();
    const getRetrievedTracesGraph = yield* XRay.GetRetrievedTracesGraph();
    const cancelTraceRetrieval = yield* XRay.CancelTraceRetrieval();

    // X-Ray read APIs have low TPS quotas; the test polls routes while
    // sibling suites run, so absorb throttling in the fixture.
    const throttleRetry = <A, E extends { _tag: string }>(
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.retry({
          while: (error): boolean => error._tag === "ThrottledException",
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(5),
          ]),
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const now = yield* Effect.sync(() => Date.now());

        if (request.method === "GET" && pathname === "/ping") {
          const functionName = yield* Effect.sync(
            () => process.env.AWS_LAMBDA_FUNCTION_NAME,
          );
          return yield* HttpServerResponse.json({ ok: true, functionName });
        }

        if (request.method === "GET" && pathname === "/trace-summaries") {
          const service = url.searchParams.get("service");
          const result = yield* throttleRetry(
            getTraceSummaries({
              StartTime: new Date(now - 10 * 60 * 1000),
              EndTime: new Date(now),
              FilterExpression: service ? `service("${service}")` : undefined,
            }),
          );
          return yield* HttpServerResponse.json({
            traceIds: (result.TraceSummaries ?? []).flatMap((summary) =>
              summary.Id ? [summary.Id] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/batch-get-traces") {
          const ids = url.searchParams.get("ids");
          const result = yield* throttleRetry(
            batchGetTraces({ TraceIds: ids ? ids.split(",") : [] }),
          );
          return yield* HttpServerResponse.json({
            traces: (result.Traces ?? []).map((trace) => ({
              id: trace.Id,
              segments: trace.Segments?.length ?? 0,
            })),
            unprocessed: result.UnprocessedTraceIds ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/put-trace-segments") {
          // A well-formed custom segment: epoch-anchored trace id, unique
          // segment id, sub-second duration.
          const epochHex = Math.floor(now / 1000).toString(16);
          const random24 = Array.from({ length: 24 }, () =>
            Math.floor(Math.random() * 16).toString(16),
          ).join("");
          const segmentId = Array.from({ length: 16 }, () =>
            Math.floor(Math.random() * 16).toString(16),
          ).join("");
          const traceId = `1-${epochHex}-${random24}`;
          const result = yield* throttleRetry(
            putTraceSegments({
              TraceSegmentDocuments: [
                JSON.stringify({
                  name: "alchemy-xray-binding-test",
                  id: segmentId,
                  trace_id: traceId,
                  start_time: now / 1000 - 0.5,
                  end_time: now / 1000,
                }),
              ],
            }),
          );
          return yield* HttpServerResponse.json({
            traceId,
            unprocessed: result.UnprocessedTraceSegments ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/telemetry") {
          yield* throttleRetry(
            putTelemetryRecords({
              TelemetryRecords: [
                {
                  Timestamp: new Date(now),
                  SegmentsReceivedCount: 1,
                  SegmentsSentCount: 1,
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/sampling") {
          const rules = yield* throttleRetry(getSamplingRules());
          const summaries = yield* throttleRetry(
            getSamplingStatisticSummaries(),
          );
          // Report sampling statistics for the built-in Default rule — the
          // real sampler protocol handshake.
          const clientId = Array.from({ length: 24 }, () =>
            Math.floor(Math.random() * 16).toString(16),
          ).join("");
          const targets = yield* Effect.result(
            getSamplingTargets({
              SamplingStatisticsDocuments: [
                {
                  RuleName: "Default",
                  ClientID: clientId,
                  Timestamp: new Date(now),
                  RequestCount: 1,
                  SampledCount: 1,
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json({
            ruleNames: (rules.SamplingRuleRecords ?? []).flatMap((record) =>
              record.SamplingRule?.RuleName
                ? [record.SamplingRule.RuleName]
                : [],
            ),
            statisticSummaries: (summaries.SamplingStatisticSummaries ?? [])
              .length,
            targets: Result.isSuccess(targets)
              ? {
                  outcome: "ok",
                  documents: (targets.success.SamplingTargetDocuments ?? [])
                    .length,
                }
              : { outcome: targets.failure._tag, documents: null },
          });
        }

        if (request.method === "GET" && pathname === "/service-graph") {
          const graph = yield* Effect.result(
            throttleRetry(
              getServiceGraph({
                StartTime: new Date(now - 10 * 60 * 1000),
                EndTime: new Date(now),
              }),
            ),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(graph)
              ? { services: (graph.success.Services ?? []).length, error: null }
              : { services: null, error: graph.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/trace-graph") {
          const ids = url.searchParams.get("ids");
          const graph = yield* Effect.result(
            throttleRetry(
              getTraceGraph({ TraceIds: ids ? ids.split(",") : [] }),
            ),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(graph)
              ? { services: (graph.success.Services ?? []).length, error: null }
              : { services: null, error: graph.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/time-series") {
          const service = url.searchParams.get("service");
          const stats = yield* Effect.result(
            getTimeSeriesServiceStatistics({
              StartTime: new Date(now - 10 * 60 * 1000),
              EndTime: new Date(now),
              EntitySelectorExpression: service
                ? `service("${service}")`
                : undefined,
              Period: 60,
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(stats)
              ? {
                  points: (stats.success.TimeSeriesServiceStatistics ?? [])
                    .length,
                  error: null,
                }
              : { points: null, error: stats.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/insight-summaries") {
          // The group may not have insights enabled — report either the
          // summary count or the API's typed error tag.
          const group = url.searchParams.get("group") ?? "Default";
          const result = yield* Effect.result(
            throttleRetry(
              getInsightSummaries({
                GroupName: group,
                StartTime: new Date(now - 24 * 60 * 60 * 1000),
                EndTime: new Date(now),
              }),
            ),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? {
                  insights: (result.success.InsightSummaries ?? []).length,
                  error: null,
                }
              : { insights: null, error: result.failure._tag },
          );
        }

        if (request.method === "GET" && pathname === "/insight") {
          // No insight can be provisioned on demand — prove each binding's
          // IAM grant by observing the API's typed validation error for a
          // syntactically-plausible but nonexistent insight id (an IAM
          // failure would surface as AccessDeniedException instead).
          const insightId =
            url.searchParams.get("id") ??
            "00000000-0000-0000-0000-000000000000";
          return yield* HttpServerResponse.json({
            getInsight: yield* outcome(getInsight({ InsightId: insightId })),
            getInsightEvents: yield* outcome(
              getInsightEvents({ InsightId: insightId }),
            ),
            getInsightImpactGraph: yield* outcome(
              getInsightImpactGraph({
                InsightId: insightId,
                StartTime: new Date(now - 60 * 60 * 1000),
                EndTime: new Date(now),
              }),
            ),
          });
        }

        if (request.method === "GET" && pathname === "/trace-retrieval") {
          // Transaction Search requires a CloudWatch Logs trace destination;
          // on the default X-Ray destination the retrieval ops answer with
          // typed errors — either way each call proves its IAM grant.
          const destination = yield* throttleRetry(
            getTraceSegmentDestination(),
          );
          const epochHex = Math.floor(now / 1000).toString(16);
          const start = yield* Effect.result(
            startTraceRetrieval({
              TraceIds: [`1-${epochHex}-abcdef0123456789abcdef01`],
              StartTime: new Date(now - 60 * 60 * 1000),
              EndTime: new Date(now),
            }),
          );
          const retrievalToken = Result.isSuccess(start)
            ? start.success.RetrievalToken
            : undefined;
          const bogusToken = retrievalToken ?? "alchemy-nonexistent-token";
          return yield* HttpServerResponse.json({
            destination: destination.Destination,
            startTraceRetrieval: Result.isFailure(start)
              ? start.failure._tag
              : "ok",
            listRetrievedTraces: yield* outcome(
              listRetrievedTraces({ RetrievalToken: bogusToken }),
            ),
            getRetrievedTracesGraph: yield* outcome(
              getRetrievedTracesGraph({ RetrievalToken: bogusToken }),
            ),
            cancelTraceRetrieval: yield* outcome(
              cancelTraceRetrieval({ RetrievalToken: bogusToken }),
            ),
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
        Lambda.EventSource,
        XRay.GetTraceSummariesHttp,
        XRay.BatchGetTracesHttp,
        XRay.PutTraceSegmentsHttp,
        XRay.PutTelemetryRecordsHttp,
        XRay.GetSamplingRulesHttp,
        XRay.GetSamplingTargetsHttp,
        XRay.GetSamplingStatisticSummariesHttp,
        XRay.GetServiceGraphHttp,
        XRay.GetTraceGraphHttp,
        XRay.GetTimeSeriesServiceStatisticsHttp,
        XRay.GetInsightHttp,
        XRay.GetInsightEventsHttp,
        XRay.GetInsightImpactGraphHttp,
        XRay.GetInsightSummariesHttp,
        XRay.GetTraceSegmentDestinationHttp,
        XRay.StartTraceRetrievalHttp,
        XRay.ListRetrievedTracesHttp,
        XRay.GetRetrievedTracesGraphHttp,
        XRay.CancelTraceRetrievalHttp,
      ),
    ),
  ),
);
