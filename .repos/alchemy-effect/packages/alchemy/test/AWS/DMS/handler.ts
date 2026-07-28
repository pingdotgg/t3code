import * as DMS from "@/AWS/DMS";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DmsTestFunction extends Lambda.Function<Lambda.Function>()(
  "DmsTestFunction",
) {}

export default DmsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // A DMS endpoint is metadata-only (free, fast) — the bindings exercise
    // ARN injection + IAM grants without a live database or replication
    // instance. (Instance-scoped bindings — TestConnection, RefreshSchemas,
    // RebootReplicationInstance, DescribeReplicationInstanceTaskLogs — need
    // a replication instance, which is AWS_TEST_SLOW territory.)
    const endpoint = yield* DMS.Endpoint("BindingsSource", {
      endpointType: "source",
      engineName: "mysql",
      serverName: "bindings-source-db.example.com",
      port: 3306,
      username: "admin",
      password: Redacted.make("correct-horse-battery-staple"),
      databaseName: "app",
    });

    // --- endpoint-scoped bindings ---
    const describeSchemas = yield* DMS.DescribeSchemas(endpoint);
    const refreshStatus = yield* DMS.DescribeRefreshSchemasStatus(endpoint);

    // --- account-level bindings ---
    const describeConnections = yield* DMS.DescribeConnections();
    const describeEvents = yield* DMS.DescribeEvents();
    const endpointSettings = yield* DMS.DescribeEndpointSettings();
    const orderable = yield* DMS.DescribeOrderableReplicationInstances();

    // --- task-orchestration bindings (account-level: task/config ARNs are
    // runtime data — DMS generates the ids, so no resource to bind) ---
    const describeReplicationTasks = yield* DMS.DescribeReplicationTasks();
    const startReplicationTask = yield* DMS.StartReplicationTask();
    const stopReplicationTask = yield* DMS.StopReplicationTask();
    const describeTableStatistics = yield* DMS.DescribeTableStatistics();
    const reloadTables = yield* DMS.ReloadTables();
    const describeReplications = yield* DMS.DescribeReplications();
    const startReplication = yield* DMS.StartReplication();
    const stopReplication = yield* DMS.StopReplication();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.dms) targeting this Function. Runtime firing needs a replication
    // instance/task lifecycle; the test verifies the rule deploys.
    yield* DMS.consumeReplicationEvents({ kinds: ["task-state"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `dms replication event: ${event.detail.sourceId} -> ${event.detail.eventType}`,
        ),
      ),
    );

    const bound = {
      describeSchemas,
      refreshStatus,
      describeConnections,
      describeEvents,
      endpointSettings,
      orderable,
      describeReplicationTasks,
      startReplicationTask,
      stopReplicationTask,
      describeTableStatistics,
      reloadTables,
      describeReplications,
      startReplication,
      stopReplication,
    };

    const EndpointArn = yield* endpoint.endpointArn;

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

        if (request.method === "GET" && pathname === "/schemas") {
          // The fixture endpoint has never had a schema refresh (that needs
          // a replication instance), so DMS answers with a typed fault —
          // which still proves ARN injection + the IAM grant end-to-end (a
          // grant gap would surface AccessDeniedException and 500 the
          // route).
          const result = yield* describeSchemas().pipe(
            Effect.map((response) => ({
              schemas: response.Schemas ?? [],
              fault: null as string | null,
            })),
            Effect.catchTag(
              ["ResourceNotFoundFault", "InvalidResourceStateFault"],
              (error) =>
                Effect.succeed({ schemas: [], fault: error._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/refresh-status") {
          const result = yield* refreshStatus().pipe(
            Effect.map((response) => ({
              status: response.RefreshSchemasStatus?.Status ?? null,
              fault: null as string | null,
            })),
            Effect.catchTag(
              ["ResourceNotFoundFault", "InvalidResourceStateFault"],
              (error) =>
                Effect.succeed({ status: null, fault: error._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/connections") {
          // No connection test has ever run against the fixture endpoint;
          // DMS answers a no-match filter with ResourceNotFoundFault.
          const endpointArn = yield* EndpointArn;
          const result = yield* describeConnections({
            Filters: [{ Name: "endpoint-arn", Values: [endpointArn] }],
          }).pipe(
            Effect.map((response) => response.Connections ?? []),
            Effect.catchTag("ResourceNotFoundFault", () => Effect.succeed([])),
          );
          return yield* HttpServerResponse.json({ count: result.length });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* describeEvents({
            SourceType: "replication-instance",
            Duration: 60,
          });
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/endpoint-settings") {
          const result = yield* endpointSettings({ EngineName: "mysql" });
          return yield* HttpServerResponse.json({
            count: (result.EndpointSettings ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/orderable") {
          const result = yield* orderable();
          return yield* HttpServerResponse.json({
            count: (result.OrderableReplicationInstances ?? []).length,
          });
        }

        // Well-formed-but-nonexistent task/config ARNs in this account —
        // derived from the fixture endpoint's ARN (same region + account).
        // Driving the task-orchestration bindings against them proves ARN
        // plumbing + IAM grants + typed error decoding without paying for a
        // replication instance: DMS answers with a typed fault (a grant gap
        // would surface AccessDeniedException and 500 the route instead).
        const arnPrefix = (yield* EndpointArn).split(":").slice(0, 5).join(":");
        const NONEXISTENT_TASK_ARN = `${arnPrefix}:task:AAAAAAAAAAAAAAAAAAAAAAAAAA`;
        const NONEXISTENT_CONFIG_ARN = `${arnPrefix}:replication-config:AAAAAAAAAAAAAAAAAAAAAAAAAA`;

        if (request.method === "GET" && pathname === "/tasks") {
          // A no-match filter answers with ResourceNotFoundFault.
          const result = yield* describeReplicationTasks({
            Filters: [
              {
                Name: "replication-task-id",
                Values: ["alchemy-nonexistent-task"],
              },
            ],
          }).pipe(
            Effect.map((response) => ({
              count: (response.ReplicationTasks ?? []).length,
              fault: null as string | null,
            })),
            Effect.catchTag("ResourceNotFoundFault", (error) =>
              Effect.succeed({ count: 0, fault: error._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/task/start") {
          const fault = yield* startReplicationTask({
            ReplicationTaskArn: NONEXISTENT_TASK_ARN,
            StartReplicationTaskType: "start-replication",
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag(
              [
                "ResourceNotFoundFault",
                "InvalidResourceStateFault",
                "AccessDeniedFault",
              ],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
        }

        if (request.method === "POST" && pathname === "/task/stop") {
          const fault = yield* stopReplicationTask({
            ReplicationTaskArn: NONEXISTENT_TASK_ARN,
          }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag(
              ["ResourceNotFoundFault", "InvalidResourceStateFault"],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
        }

        if (request.method === "GET" && pathname === "/task/tables") {
          const fault = yield* describeTableStatistics({
            ReplicationTaskArn: NONEXISTENT_TASK_ARN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "ResourceNotFoundFault",
                "InvalidResourceStateFault",
                "AccessDeniedFault",
              ],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
        }

        if (request.method === "POST" && pathname === "/task/reload") {
          const fault = yield* reloadTables({
            ReplicationTaskArn: NONEXISTENT_TASK_ARN,
            TablesToReload: [
              { SchemaName: "public", TableName: "nonexistent" },
            ],
          }).pipe(
            Effect.map(() => "Reloaded"),
            Effect.catchTag(
              ["ResourceNotFoundFault", "InvalidResourceStateFault"],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
        }

        if (request.method === "GET" && pathname === "/replications") {
          const result = yield* describeReplications({
            Filters: [
              {
                Name: "replication-config-arn",
                Values: [NONEXISTENT_CONFIG_ARN],
              },
            ],
          }).pipe(
            Effect.map((response) => ({
              count: (response.Replications ?? []).length,
              fault: null as string | null,
            })),
            Effect.catchTag("ResourceNotFoundFault", (error) =>
              Effect.succeed({ count: 0, fault: error._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/replication/start") {
          const fault = yield* startReplication({
            ReplicationConfigArn: NONEXISTENT_CONFIG_ARN,
            StartReplicationType: "start-replication",
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag(
              [
                "ResourceNotFoundFault",
                "InvalidResourceStateFault",
                "AccessDeniedFault",
              ],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
        }

        if (request.method === "POST" && pathname === "/replication/stop") {
          const fault = yield* stopReplication({
            ReplicationConfigArn: NONEXISTENT_CONFIG_ARN,
          }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag(
              [
                "ResourceNotFoundFault",
                "InvalidResourceStateFault",
                "AccessDeniedFault",
              ],
              (error) => Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ fault });
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
        DMS.DescribeSchemasHttp,
        DMS.DescribeRefreshSchemasStatusHttp,
        DMS.DescribeConnectionsHttp,
        DMS.DescribeEventsHttp,
        DMS.DescribeEndpointSettingsHttp,
        DMS.DescribeOrderableReplicationInstancesHttp,
        DMS.DescribeReplicationTasksHttp,
        DMS.StartReplicationTaskHttp,
        DMS.StopReplicationTaskHttp,
        DMS.DescribeTableStatisticsHttp,
        DMS.ReloadTablesHttp,
        DMS.DescribeReplicationsHttp,
        DMS.StartReplicationHttp,
        DMS.StopReplicationHttp,
      ),
    ),
  ),
);
