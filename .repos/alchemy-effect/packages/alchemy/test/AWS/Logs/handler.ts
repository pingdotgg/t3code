import * as Lambda from "@/AWS/Lambda";
import * as Logs from "@/AWS/Logs";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LogsTestFunction extends Lambda.Function<Lambda.Function>()(
  "LogsTestFunction",
) {}

class QueryNotComplete extends Data.TaggedError("QueryNotComplete")<{
  readonly status: string | undefined;
}> {}

export default LogsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const logGroup = yield* Logs.LogGroup("BindingsLogGroup", {
      retention: "1 day",
    });
    const logStream = yield* Logs.LogStream("BindingsLogStream", {
      logGroupName: logGroup.logGroupName,
      logStreamName: "alchemy-test-bindings-stream",
    });

    const putLogEvents = yield* Logs.PutLogEvents(logGroup);
    const filterLogEvents = yield* Logs.FilterLogEvents(logGroup);
    const getLogEvents = yield* Logs.GetLogEvents(logGroup);
    const startQuery = yield* Logs.StartQuery(logGroup);
    const getQueryResults = yield* Logs.GetQueryResults(logGroup);
    const stopQuery = yield* Logs.StopQuery(logGroup);
    const getLogRecord = yield* Logs.GetLogRecord(logGroup);
    const getLogGroupFields = yield* Logs.GetLogGroupFields(logGroup);
    const describeLogStreams = yield* Logs.DescribeLogStreams(logGroup);
    const createLogStream = yield* Logs.CreateLogStream(logGroup);
    const deleteLogStream = yield* Logs.DeleteLogStream(logGroup);

    const LogStreamName = yield* logStream.logStreamName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const logStreamName = yield* LogStreamName;

        if (request.method === "POST" && pathname === "/put") {
          const message = url.searchParams.get("message") ?? "no-message";
          const timestamp = yield* Clock.currentTimeMillis;
          const result = yield* putLogEvents({
            logStreamName,
            logEvents: [{ timestamp, message }],
          });
          return yield* HttpServerResponse.json({
            ok: true,
            rejected: result.rejectedLogEventsInfo ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/filter") {
          const pattern = url.searchParams.get("pattern") ?? "";
          const result = yield* filterLogEvents({
            filterPattern: `"${pattern}"`,
          });
          return yield* HttpServerResponse.json({
            messages: (result.events ?? []).map((event) => event.message),
          });
        }

        if (request.method === "GET" && pathname === "/get-events") {
          const result = yield* getLogEvents({
            logStreamName,
            startFromHead: true,
          });
          return yield* HttpServerResponse.json({
            messages: (result.events ?? []).map((event) => event.message),
          });
        }

        if (request.method === "GET" && pathname === "/query") {
          const now = yield* Clock.currentTimeMillis;
          const { queryId } = yield* startQuery({
            queryString: "fields @timestamp, @message | limit 10",
            startTime: Math.floor(now / 1000) - 3600,
            endTime: Math.floor(now / 1000) + 60,
          });
          if (!queryId) {
            return yield* HttpServerResponse.json(
              { error: "no queryId" },
              { status: 500 },
            );
          }
          // Poll bounded (~20s) — well inside the 30s function timeout.
          const results = yield* getQueryResults({ queryId }).pipe(
            Effect.flatMap((response) =>
              response.status === "Complete"
                ? Effect.succeed(response)
                : Effect.fail(
                    new QueryNotComplete({ status: response.status }),
                  ),
            ),
            Effect.retry({
              while: (error) => error._tag === "QueryNotComplete",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          // Surface the first row's @ptr so the test can exercise GetLogRecord.
          const ptr =
            (results.results ?? [])
              .flat()
              .find((field) => field.field === "@ptr")?.value ?? null;
          return yield* HttpServerResponse.json({
            queryId,
            status: results.status,
            resultCount: (results.results ?? []).length,
            ptr,
          });
        }

        if (request.method === "GET" && pathname === "/record") {
          const ptr = url.searchParams.get("ptr");
          if (!ptr) {
            return yield* HttpServerResponse.json(
              { error: "missing ptr" },
              { status: 400 },
            );
          }
          const { logRecord } = yield* getLogRecord({ logRecordPointer: ptr });
          return yield* HttpServerResponse.json({
            message: logRecord?.["@message"] ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/stop-query") {
          const now = yield* Clock.currentTimeMillis;
          const { queryId } = yield* startQuery({
            queryString: "fields @timestamp, @message | limit 10000",
            startTime: Math.floor(now / 1000) - 86_400,
            endTime: Math.floor(now / 1000) + 60,
          });
          if (!queryId) {
            return yield* HttpServerResponse.json(
              { error: "no queryId" },
              { status: 500 },
            );
          }
          // Give the query registration a beat to propagate before stopping.
          yield* Effect.sleep("500 millis");
          const outcome = yield* stopQuery({ queryId }).pipe(
            Effect.map((response) => ({
              stopped: response.success ?? true,
              error: null as string | null,
            })),
            // Benign races: the query can complete before the stop lands
            // (InvalidParameterException) or the stop can outrun the query's
            // registration (ResourceNotFoundException). Both still prove the
            // binding round-tripped with valid credentials.
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (error) => Effect.succeed({ stopped: false, error: error._tag }),
            ),
          );
          return yield* HttpServerResponse.json({ ok: true, ...outcome });
        }

        if (request.method === "GET" && pathname === "/fields") {
          const { logGroupFields } = yield* getLogGroupFields();
          return yield* HttpServerResponse.json({
            fields: (logGroupFields ?? []).map((field) => field.name),
          });
        }

        if (request.method === "GET" && pathname === "/streams") {
          const { logStreams } = yield* describeLogStreams({ limit: 10 });
          return yield* HttpServerResponse.json({
            streams: (logStreams ?? []).map((stream) => stream.logStreamName),
          });
        }

        if (request.method === "POST" && pathname === "/stream-lifecycle") {
          const name = url.searchParams.get("name");
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "missing name" },
              { status: 400 },
            );
          }
          yield* createLogStream({ logStreamName: name }).pipe(
            Effect.catchTag(
              "ResourceAlreadyExistsException",
              () => Effect.void,
            ),
          );
          const { logStreams } = yield* describeLogStreams({
            logStreamNamePrefix: name,
          });
          const seen = (logStreams ?? []).some(
            (stream) => stream.logStreamName === name,
          );
          yield* deleteLogStream({ logStreamName: name }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          const after = yield* describeLogStreams({
            logStreamNamePrefix: name,
          });
          const gone = !(after.logStreams ?? []).some(
            (stream) => stream.logStreamName === name,
          );
          return yield* HttpServerResponse.json({ seen, gone });
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
        Logs.PutLogEventsHttp,
        Logs.FilterLogEventsHttp,
        Logs.GetLogEventsHttp,
        Logs.StartQueryHttp,
        Logs.GetQueryResultsHttp,
        Logs.StopQueryHttp,
        Logs.GetLogRecordHttp,
        Logs.GetLogGroupFieldsHttp,
        Logs.DescribeLogStreamsHttp,
        Logs.CreateLogStreamHttp,
        Logs.DeleteLogStreamHttp,
      ),
    ),
  ),
);
