import { EventBus } from "@/AWS/EventBridge";
import * as Lambda from "@/AWS/Lambda";
import * as Schemas from "@/AWS/Schemas";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SchemasTestFunction extends Lambda.Function<Lambda.Function>()(
  "SchemasTestFunction",
) {}

/** The OpenAPI 3 document registered as the fixture schema. */
const ORDER_CREATED_CONTENT = JSON.stringify({
  openapi: "3.0.0",
  info: { version: "1.0.0", title: "OrderCreated" },
  paths: {},
  components: {
    schemas: {
      OrderCreated: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          amount: { type: "number" },
        },
      },
    },
  },
});

/** A full AWS event envelope for GetDiscoveredSchema inference. */
const SAMPLE_EVENT = JSON.stringify({
  version: "0",
  id: "12345678-1234-1234-1234-123456789012",
  "detail-type": "OrderCreated",
  source: "alchemy.test",
  account: "123456789012",
  time: "2026-01-01T00:00:00Z",
  region: "us-east-1",
  resources: [],
  detail: { orderId: "abc", amount: 42 },
});

const CODE_BINDING_LANGUAGE = "Python36";

export default SchemasTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
    // The default 128 MB sits at ~114 MB used; the last routes in a test run
    // OOM the instance (platform-level 500 with no handler log).
    memorySize: 512,
  },
  Effect.gen(function* () {
    const registry = yield* Schemas.Registry("BindingsRegistry", {
      description: "alchemy schemas bindings fixture registry",
    });

    const schema = yield* Schemas.Schema("BindingsSchema", {
      registryName: registry.registryName,
      type: "OpenApi3",
      content: ORDER_CREATED_CONTENT,
      description: "alchemy schemas bindings fixture schema",
    });

    // The discoverer the start/stop bindings are bound to — on a dedicated
    // bus that carries no traffic, so it never publishes junk schemas.
    const bus = yield* EventBus("BindingsBus", {});
    const discoverer = yield* Schemas.Discoverer("BindingsDiscoverer", {
      sourceArn: bus.eventBusArn,
      description: "alchemy schemas bindings fixture discoverer",
    });

    // Event source: subscribe the host to schema-registry notifications.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* Schemas.consumeSchemaEvents(
      { kinds: ["schema-created", "schema-version-created"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `schema event: ${event.detail.RegistryName}/${event.detail.SchemaName} v${event.detail.SchemaVersion}`,
          ),
        ),
    );

    const describeSchema = yield* Schemas.DescribeSchema(schema);
    const exportSchema = yield* Schemas.ExportSchema(schema);
    const listSchemaVersions = yield* Schemas.ListSchemaVersions(schema);
    const searchSchemas = yield* Schemas.SearchSchemas(registry);
    const getDiscoveredSchema = yield* Schemas.GetDiscoveredSchema();
    const putCodeBinding = yield* Schemas.PutCodeBinding(schema);
    const describeCodeBinding = yield* Schemas.DescribeCodeBinding(schema);
    const getCodeBindingSource = yield* Schemas.GetCodeBindingSource(schema);
    const startDiscoverer = yield* Schemas.StartDiscoverer(discoverer);
    const stopDiscoverer = yield* Schemas.StopDiscoverer(discoverer);

    const bound = {
      describeSchema,
      exportSchema,
      listSchemaVersions,
      searchSchemas,
      getDiscoveredSchema,
      putCodeBinding,
      describeCodeBinding,
      getCodeBindingSource,
      startDiscoverer,
      stopDiscoverer,
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

        // Schema-scoped read: registry + schema names are injected.
        if (request.method === "GET" && pathname === "/schema") {
          const response = yield* describeSchema();
          return yield* HttpServerResponse.json({
            name: response.SchemaName,
            type: response.Type,
            version: response.SchemaVersion,
            hasContent: !!response.Content,
          });
        }

        // Export the schema as JSONSchemaDraft4. AWS only allows exporting
        // discovered / AWS-managed schemas, so on this custom-registry
        // schema the call surfaces the typed ForbiddenException — the route
        // reports which outcome occurred so the test can assert the typed
        // error (proving the binding + IAM wiring end-to-end).
        if (request.method === "GET" && pathname === "/export") {
          const response = yield* exportSchema({
            Type: "JSONSchemaDraft4",
          }).pipe(
            Effect.map((r) => ({
              outcome: "exported" as const,
              hasContent: !!r.Content,
            })),
            Effect.catchTag("ForbiddenException", (e) =>
              Effect.succeed({
                outcome: "forbidden" as const,
                message: e.Message ?? "",
              }),
            ),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/versions") {
          const response = yield* listSchemaVersions();
          return yield* HttpServerResponse.json({
            versions: (response.SchemaVersions ?? []).map(
              (v) => v.SchemaVersion,
            ),
          });
        }

        // Registry-scoped search: the registry name is injected.
        if (request.method === "GET" && pathname === "/search") {
          const response = yield* searchSchemas({ Keywords: "order" });
          return yield* HttpServerResponse.json({
            names: (response.Schemas ?? []).map((s) => s.SchemaName),
          });
        }

        // Account-level inference from sample events.
        if (request.method === "POST" && pathname === "/discover") {
          const response = yield* getDiscoveredSchema({
            Type: "OpenApi3",
            Events: [SAMPLE_EVENT],
          });
          return yield* HttpServerResponse.json({
            hasContent: !!response.Content,
          });
        }

        // Kick off async code-binding generation. Re-running against an
        // already-generated binding returns the typed ConflictException —
        // treat it as "generation already complete" so the route is
        // idempotent across test re-runs.
        if (request.method === "POST" && pathname === "/codebinding") {
          const response = yield* putCodeBinding({
            Language: CODE_BINDING_LANGUAGE,
          }).pipe(
            Effect.catchTag("ConflictException", () =>
              Effect.succeed({ Status: "CREATE_COMPLETE" as const }),
            ),
          );
          return yield* HttpServerResponse.json({ status: response.Status });
        }

        // Poll generation status (NOT_FOUND until PutCodeBinding ran).
        if (request.method === "GET" && pathname === "/codebinding") {
          const response = yield* describeCodeBinding({
            Language: CODE_BINDING_LANGUAGE,
          }).pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed({ Status: "NOT_FOUND" as const }),
            ),
          );
          return yield* HttpServerResponse.json({ status: response.Status });
        }

        // Download the generated package (a zip streamed as Body).
        if (request.method === "GET" && pathname === "/codebinding/source") {
          const bytes = yield* getCodeBindingSource({
            Language: CODE_BINDING_LANGUAGE,
          }).pipe(
            Effect.flatMap((response) =>
              response.Body === undefined
                ? Effect.succeed(0)
                : Stream.runFold(
                    response.Body,
                    () => 0,
                    (n, chunk) => n + chunk.length,
                  ),
            ),
            Effect.catchTag("NotFoundException", () => Effect.succeed(-1)),
          );
          return yield* HttpServerResponse.json({ bytes });
        }

        // Discoverer-scoped control plane: the discoverer id is injected.
        if (request.method === "POST" && pathname === "/discoverer/stop") {
          const response = yield* stopDiscoverer();
          return yield* HttpServerResponse.json({ state: response.State });
        }
        if (request.method === "POST" && pathname === "/discoverer/start") {
          const response = yield* startDiscoverer();
          return yield* HttpServerResponse.json({ state: response.State });
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
        Schemas.DescribeSchemaHttp,
        Schemas.ExportSchemaHttp,
        Schemas.ListSchemaVersionsHttp,
        Schemas.SearchSchemasHttp,
        Schemas.GetDiscoveredSchemaHttp,
        Schemas.PutCodeBindingHttp,
        Schemas.DescribeCodeBindingHttp,
        Schemas.GetCodeBindingSourceHttp,
        Schemas.StartDiscovererHttp,
        Schemas.StopDiscovererHttp,
      ),
    ),
  ),
);
