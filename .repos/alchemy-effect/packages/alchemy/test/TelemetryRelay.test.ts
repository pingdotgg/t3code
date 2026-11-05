import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { packEnvValue } from "@/RuntimeContext.ts";
import * as Telemetry from "@/Telemetry.ts";

/** The backend's own OTLP destination, as a Worker would have it bound. */
const backend = ConfigProvider.make((path) =>
  Effect.sync(() => {
    switch (path.join("_")) {
      case "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT":
        return ConfigProvider.makeValue("https://collector.example/v1/traces");
      case "OTEL_EXPORTER_OTLP_HEADERS":
        return ConfigProvider.makeValue(
          packEnvValue(Redacted.make("authorization=Bearer%20secret")),
        );
      default:
        return undefined;
    }
  }),
);

/** Post `body` to the relay, as a browser would, and record what it forwards. */
const post = (
  relay: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
  options: { path?: string; body?: string; headers?: Record<string, string>; status?: number } = {},
) =>
  Effect.gen(function* () {
    const forwarded: Array<{ request: HttpClientRequest.HttpClientRequest; body: string }> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        forwarded.push({ request, body });
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: options.status ?? 200 }),
        );
      }),
    );
    const body = options.body ?? '{"resourceSpans":[]}';
    const incoming = HttpServerRequest.fromWeb(
      new Request(`https://app.example${options.path ?? "/api/telemetry/v1/traces"}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          ...options.headers,
        },
      }),
    );
    const response = yield* relay.pipe(
      Effect.provideContext(
        Context.make(HttpServerRequest.HttpServerRequest, incoming).pipe(
          Context.add(HttpClient.HttpClient, client),
          Context.add(ConfigProvider.ConfigProvider, backend),
        ),
      ),
    );
    return { status: response.status, forwarded };
  });

describe("Telemetry.relay", { tags: ["unit", "local"] }, () => {
  it.effect(
    "forwards a client's batch to the backend's destination, with the backend's headers",
    () =>
      Effect.gen(function* () {
        const { status, forwarded } = yield* post(Telemetry.relay());
        expect(status).toBe(200);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]!.request.url).toBe("https://collector.example/v1/traces");
        expect(forwarded[0]!.request.headers.authorization).toBe("Bearer secret");
        expect(forwarded[0]!.body).toBe('{"resourceSpans":[]}');
      }),
  );

  it.effect("routes a batch wherever `route` says", () =>
    Effect.gen(function* () {
      const relay = Telemetry.relay({
        route: (signal, configured) =>
          Effect.succeed([
            ...configured.map((d) => ({
              ...d,
              headers: { ...d.headers, "x-dataset": `browser-${signal}` },
            })),
            { url: "https://other.example/v1/traces" },
          ]),
      });
      const { forwarded } = yield* post(relay);
      expect(forwarded.map((f) => f.request.url)).toEqual([
        "https://collector.example/v1/traces",
        "https://other.example/v1/traces",
      ]);
      expect(forwarded[0]!.request.headers["x-dataset"]).toBe("browser-traces");
      expect(forwarded[0]!.request.headers.authorization).toBe("Bearer secret");
    }),
  );

  it.effect("refuses what it isn't configured to accept", () =>
    Effect.gen(function* () {
      const tracesOnly = Telemetry.relay({ signals: ["traces"], maxBytes: 64 });
      expect((yield* post(tracesOnly, { path: "/api/telemetry/v1/logs" })).status).toBe(404);
      expect((yield* post(tracesOnly, { path: "/api/telemetry/v1/nope" })).status).toBe(404);
      const big = yield* post(tracesOnly, { body: "x".repeat(100) });
      expect(big.status).toBe(413);
      expect(big.forwarded).toHaveLength(0);

      const signedIn = Telemetry.relay({
        authorize: Effect.map(
          HttpServerRequest.HttpServerRequest,
          (r) => r.headers.cookie === "session=ok",
        ),
      });
      expect((yield* post(signedIn)).status).toBe(403);
      expect((yield* post(signedIn, { headers: { cookie: "session=ok" } })).status).toBe(200);
    }),
  );

  it.effect("reports a batch no destination accepted", () =>
    Effect.gen(function* () {
      const { status, forwarded } = yield* post(Telemetry.relay(), { status: 500 });
      expect(forwarded).toHaveLength(1);
      expect(status).toBe(502);
    }),
  );
});
