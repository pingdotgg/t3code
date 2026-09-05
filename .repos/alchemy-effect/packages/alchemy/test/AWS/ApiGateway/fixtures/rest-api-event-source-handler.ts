import * as ApiGateway from "@/AWS/ApiGateway";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class RestApiEventSourceFunction extends Lambda.Function<RestApiEventSourceFunction>()(
  "RestApiEventSourceFunction",
) {}

/**
 * Fixture: a Lambda that owns a REST API and serves two routes through the
 * `RestApiEventSource` (`onRestApiRoute`) binding. The event source
 * materializes the `Resource` chain, `AWS_PROXY` `Method`s, and the invoke
 * `Permission`; the `Deployment`/`Stage` below are ordered after them via
 * the API's binding contract.
 *
 * Deliberately does NOT `yield*` any `api.*`/`stage.*` outputs: the API's
 * full `create` settles only after every bound child (including the
 * `Method`s that reference `host.functionArn`), so awaiting those outputs
 * inside the host's own effect would deadlock the plan. The test discovers
 * the REST API id out-of-band by its deterministic physical name.
 */
export default RestApiEventSourceFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const api = yield* ApiGateway.RestApi("AgEsApi", {
      endpointConfiguration: { types: ["REGIONAL"] },
    });

    // GET /items — static JSON response.
    yield* ApiGateway.onRestApiRoute(
      api,
      { path: "/items", httpMethod: "GET" },
      () =>
        Effect.succeed({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: ["alpha", "beta"] }),
        }),
    );

    // POST /echo — proves the proxy event (method, resource, body) reaches
    // the handler intact.
    yield* ApiGateway.onRestApiRoute(
      api,
      { path: "/echo", httpMethod: "POST" },
      (event) =>
        Effect.sync(() => ({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: event.httpMethod,
            resource: event.resource,
            echoed: event.body === null ? null : JSON.parse(event.body),
          }),
        })),
    );

    const deployment = yield* ApiGateway.Deployment("AgEsDep", {
      restApi: api,
    });
    yield* ApiGateway.Stage("AgEsStage", {
      restApi: api,
      stageName: "test",
      deploymentId: deployment.deploymentId,
    });

    return {
      // Readiness probe only — the REST routes are served via the event
      // source, not the function URL.
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(Effect.provide(Lambda.RestApiEventSource)),
);
