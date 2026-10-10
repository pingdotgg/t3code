import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redactable from "effect/Redactable";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import * as ServerConfig from "./config.ts";
import * as ServerLogger from "./serverLogger.ts";

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers every export with a 200 and keeps what was posted for assertions. */
const layerCollector = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const layerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "t3-server-logger-test");
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      return ServerConfig.make({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        cwd: baseDir,
        baseDir,
        ...derivedPaths,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 0,
        host: undefined,
        desktopBootstrapToken: undefined,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: false,
        startupPresentation: "browser",
        ...overrides,
      });
    }),
  ).pipe(Layer.provide(NodePath.layer));

/**
 * Logs once with the server's own logger set installed, then reports what the
 * collector received. The export is asserted after the layer's scope closes,
 * which is where the exporter flushes whatever the interval did not.
 */
const logThrough = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    yield* Effect.log("server logger under test").pipe(
      Effect.provide(
        ServerLogger.layer.pipe(
          Layer.provide(layerConfig(overrides)),
          Layer.provide(layerCollector(requests)),
        ),
      ),
    );
    return requests;
  });

/**
 * Logs inside a span so the tracer logger has somewhere to attach an event,
 * then reports both what the collector received and what landed on the span.
 */
const logInSpanThrough = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);
          return span;
        },
      }),
    );
    yield* Effect.log("server logger under test").pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(
        Layer.mergeAll(
          ServerLogger.layer.pipe(
            Layer.provide(layerConfig(overrides)),
            Layer.provide(layerCollector(requests)),
          ),
          layerTracer,
        ),
      ),
    );
    return { requests, spans };
  });

/** Logs one warning through the server logger and returns what its console printed. */
const printThroughConsole = (fields: object) =>
  Effect.gen(function* () {
    const printed: Array<string> = [];
    const testConsole = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        printed.push(NodeUtil.format(...args));
      },
    } satisfies Console.Console;
    yield* Effect.logWarning("pull request watch check failed", fields).pipe(
      Effect.provide(
        ServerLogger.layer.pipe(Layer.provide(layerConfig({})), Layer.provide(layerCollector([]))),
      ),
      Effect.provideService(Console.Console, testConsole),
    );
    return printed.join("\n");
  });

describe("ServerLoggerLive", () => {
  it.effect("exports log records to the configured logs endpoint", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
      });

      assert.lengthOf(requests, 1);
      const [request] = requests;
      assert.strictEqual(request?.url, "https://collector.example.com/v1/logs");
      assert.include(request?.body ?? "", "server logger under test");
      assert.include(request?.body ?? "", "t3code-server");
      assert.include(request?.body ?? "", "service.runtime");
    }),
  );

  it.effect("keeps its service name while OTEL resource attributes add dimensions", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                OTEL_SERVICE_NAME: "renamed",
                OTEL_RESOURCE_ATTRIBUTES:
                  "service.name=renamed,service.namespace=renamed,deployment.environment.name=development",
              },
            }),
          ),
        ),
      );

      assert.lengthOf(requests, 1);
      const body = requests[0]?.body ?? "";
      assert.include(body, '"stringValue":"t3code-server"');
      assert.include(body, "deployment.environment.name");
      assert.include(body, '"key":"service.namespace","value":{"stringValue":"t3code"}');
      assert.notInclude(body, "renamed");
    }),
  );

  it.effect("stays off the network when no logs endpoint is configured", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({});

      assert.lengthOf(requests, 0);
    }),
  );

  it.effect("sends the headers and wire format the log signal asked for", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
        otlpLogsExport: {
          ...DEFAULT_SIGNAL_EXPORT,
          protocol: "http/protobuf",
          headers: { "x-scope": "logs" },
        },
      });

      assert.lengthOf(requests, 1);
      assert.strictEqual(requests[0]?.headers["x-scope"], "logs");
      assert.strictEqual(requests[0]?.headers["content-type"], "application/x-protobuf");
    }),
  );

  it.effect("attaches log messages to the active span when no logs endpoint is configured", () =>
    Effect.gen(function* () {
      const { requests, spans } = yield* logInSpanThrough({});

      assert.lengthOf(requests, 0);
      assert.lengthOf(spans, 1);
      assert.deepEqual(
        spans[0]?.events.map(([name]) => name),
        ["server logger under test"],
      );
    }),
  );

  it.effect("stops duplicating messages onto the span once log records are exported", () =>
    Effect.gen(function* () {
      const { requests, spans } = yield* logInSpanThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
      });

      assert.lengthOf(requests, 1);
      assert.include(requests[0]?.body ?? "", "server logger under test");
      assert.lengthOf(spans, 1);
      assert.lengthOf(spans[0]?.events ?? [], 0);
    }),
  );

  it.effect("prints a cause passed as a log field instead of collapsing it", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        threadId: "thread-1",
        cause: Cause.fail(new Error("gh: HTTP 502 from api.github.com")),
      });

      assert.include(output, "threadId: 'thread-1'");
      assert.include(output, "gh: HTTP 502 from api.github.com");
      assert.notInclude(output, "[Object]");
    }),
  );

  it.effect("leaves getters uncalled while printing a cause field", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        cause: Cause.fail(new Error("upstream refused")),
        get detail(): string {
          throw new Error("getter must not run");
        },
      });

      assert.include(output, "upstream refused");
      assert.notInclude(output, "getter must not run");
    }),
  );

  it.effect("leaves a message with its own redaction hook to that hook", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        token: "secret-token-value",
        cause: Cause.fail(new Error("upstream refused")),
        [Redactable.symbolRedactable](this: { readonly cause: unknown }) {
          return { token: "<redacted>", cause: Cause.isCause(this.cause) ? "cause" : "missing" };
        },
      });

      assert.include(output, "token: '<redacted>'");
      assert.include(output, "cause: 'cause'");
      assert.notInclude(output, "secret-token-value");
    }),
  );
});
