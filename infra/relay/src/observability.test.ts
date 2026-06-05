import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { OtlpTracer } from "effect/unstable/observability";

import { EnvironmentMintRequestFailed } from "./environments/EnvironmentConnector.ts";
import { makeRelayTraceLayer } from "./observability.ts";

interface ExportedRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly dataset: string | undefined;
}

const otlpAttributeValue = (value: {
  readonly stringValue?: string | null;
  readonly boolValue?: boolean | null;
  readonly intValue?: number | null;
  readonly doubleValue?: number | null;
}) => value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue;

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

it.effect("exports schema error fields as span attributes", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* Deferred.make<ExportedRequest>();
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Deferred.succeed(exportedRequest, {
          authorization: request.headers.authorization,
          body: yield* request.text,
          dataset: request.headers["x-axiom-dataset"],
        });
        return HttpServerResponse.empty({ status: 204 });
      }),
    );

    yield* Effect.fail(
      new EnvironmentMintRequestFailed({
        environmentId: "environment-1",
        operation: "connect",
        cause: new Error("upstream unavailable"),
      }),
    ).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Effect.provide(
        makeRelayTraceLayer({
          tracesEndpoint: "/v1/traces",
          tracesDatasetName: "relay-test-traces",
          ingestToken: Redacted.make("test-token"),
        }),
      ),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const payload = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = payload.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.schema_error");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(request.authorization).toBe("Bearer test-token");
    expect(request.dataset).toBe("relay-test-traces");
    expect(attributes).toMatchObject({
      "error.type": "EnvironmentMintRequestFailed",
      "error.environmentId": "environment-1",
      "error.operation": "connect",
      "error.cause.name": "Error",
      "error.cause.message": "upstream unavailable",
    });
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);
