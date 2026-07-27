import * as InternetMonitor from "@/AWS/InternetMonitor";
import * as Lambda from "@/AWS/Lambda";
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

// A syntactically-plausible but nonexistent event id.
const BOGUS_EVENT_ID = "alchemy-nonexistent-internetmonitor-event-id";

export class InternetMonitorBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "InternetMonitorBindingsFunction",
) {}

export default InternetMonitorBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // An empty monitor is cheap (no monitored resources, 1 city-network
    // cap) and still exercises the monitor-scoped grants + name injection.
    const monitor = yield* InternetMonitor.Monitor("BindingsMonitor", {
      resources: [],
      maxCityNetworksToMonitor: 1,
    });

    // Event source: subscribe the host to this monitor's health events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* InternetMonitor.consumeHealthEvents(
      { monitorArns: [monitor.monitorArn], statuses: ["ACTIVE", "RESOLVED"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `internet-monitor health event: ${event.detail.summary} (${event.detail.impactType})`,
          ),
        ),
    );

    const bound = {
      getHealthEvent: yield* InternetMonitor.GetHealthEvent(monitor),
      listHealthEvents: yield* InternetMonitor.ListHealthEvents(monitor),
      startQuery: yield* InternetMonitor.StartQuery(monitor),
      getQueryStatus: yield* InternetMonitor.GetQueryStatus(monitor),
      getQueryResults: yield* InternetMonitor.GetQueryResults(monitor),
      stopQuery: yield* InternetMonitor.StopQuery(monitor),
      getInternetEvent: yield* InternetMonitor.GetInternetEvent(),
      listInternetEvents: yield* InternetMonitor.ListInternetEvents(),
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

        // Monitor-scoped list — the monitor name is injected; a fresh empty
        // monitor has no health events.
        if (request.method === "GET" && pathname === "/health-events") {
          const { HealthEvents } = yield* bound.listHealthEvents();
          return yield* HttpServerResponse.json({
            count: (HealthEvents ?? []).length,
          });
        }

        // Typed probe: the request round-trips to the monitor-scoped API
        // (an IAM gap would surface AccessDeniedException instead).
        if (
          request.method === "GET" &&
          pathname === "/health-events/typed-probe"
        ) {
          const tag = yield* bound
            .getHealthEvent({ EventId: BOGUS_EVENT_ID })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            );
          return yield* HttpServerResponse.json({ tag });
        }

        // Account-level list of global internet events.
        if (request.method === "GET" && pathname === "/internet-events") {
          const { InternetEvents } = yield* bound.listInternetEvents({
            MaxResults: 10,
          });
          return yield* HttpServerResponse.json({
            count: (InternetEvents ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/internet-event/typed-probe"
        ) {
          const tag = yield* bound
            .getInternetEvent({ EventId: BOGUS_EVENT_ID })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            );
          return yield* HttpServerResponse.json({ tag });
        }

        // Full query-interface loop: start a MEASUREMENTS query over the
        // trailing hour, poll (bounded) until terminal, read results when
        // it succeeds, and probe StopQuery's grant on the finished query.
        // Each step reports its typed failure so a single grant gap is
        // diagnosable from the JSON instead of a generic 500.
        if (request.method === "GET" && pathname === "/query") {
          const now = yield* Effect.sync(() => Date.now());
          const started = yield* Effect.result(
            bound.startQuery({
              StartTime: new Date(now - 3_600_000),
              EndTime: new Date(now),
              QueryType: "MEASUREMENTS",
            }),
          );
          if (Result.isFailure(started)) {
            return yield* HttpServerResponse.json({
              step: "startQuery",
              tag: started.failure._tag,
              error: String(started.failure),
            });
          }
          const QueryId = started.success.QueryId;
          const polled = yield* Effect.result(
            bound.getQueryStatus({ QueryId }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (r): boolean =>
                  r.Status !== "QUEUED" && r.Status !== "RUNNING",
                times: 20,
              }),
            ),
          );
          if (Result.isFailure(polled)) {
            return yield* HttpServerResponse.json({
              step: "getQueryStatus",
              tag: polled.failure._tag,
              error: String(polled.failure),
            });
          }
          const Status = polled.success.Status;
          const results = yield* Effect.result(
            Status === "SUCCEEDED"
              ? bound.getQueryResults({ QueryId })
              : Effect.succeed({ Fields: [], Data: [] }),
          );
          if (Result.isFailure(results)) {
            return yield* HttpServerResponse.json({
              step: "getQueryResults",
              tag: results.failure._tag,
              error: String(results.failure),
            });
          }
          // Stopping an already-terminal query may be rejected — either the
          // success or the typed rejection proves internetmonitor:StopQuery.
          const stopTag = yield* bound.stopQuery({ QueryId }).pipe(
            Effect.map(() => "ok"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({
            step: "ok",
            queryId: QueryId,
            status: Status,
            fields: (results.success.Fields ?? []).length,
            rows: (results.success.Data ?? []).length,
            stopTag,
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
        InternetMonitor.GetHealthEventHttp,
        InternetMonitor.ListHealthEventsHttp,
        InternetMonitor.StartQueryHttp,
        InternetMonitor.GetQueryStatusHttp,
        InternetMonitor.GetQueryResultsHttp,
        InternetMonitor.StopQueryHttp,
        InternetMonitor.GetInternetEventHttp,
        InternetMonitor.ListInternetEventsHttp,
      ),
    ),
  ),
);
