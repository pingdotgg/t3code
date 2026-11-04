import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { configuredDestinations, type ResolvedSignal } from "./TelemetryRuntime.ts";

/** An OpenTelemetry signal the relay forwards. */
export type Signal = "traces" | "logs" | "metrics";

/** Where the relay forwards one batch: an OTLP/HTTP endpoint and the headers to send it. */
export interface Destination {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options for {@link relay}. */
export interface RelayOptions<R = never> {
  /**
   * The signals the relay accepts. A post for any other gets a 404.
   * @default ["traces", "logs", "metrics"]
   */
  readonly signals?: ReadonlyArray<Signal>;
  /**
   * The largest body accepted, in bytes. Larger posts get a 413.
   * @default 1048576
   */
  readonly maxBytes?: number;
  /**
   * Decide whether to accept a post, e.g. only from signed-in users. A post
   * it refuses gets a 403. The relay is a public endpoint, so gate it when
   * you can.
   * @default every post is accepted
   */
  readonly authorize?: Effect.Effect<boolean, never, R | HttpServerRequest>;
  /**
   * Choose where a batch goes. It receives the destinations this runtime
   * exports its own telemetry to, and returns the ones to forward to: all
   * of them, some, or others entirely.
   * @default the runtime's own destinations for that signal
   */
  readonly route?: (
    signal: Signal,
    configured: ReadonlyArray<Destination>,
  ) => Effect.Effect<ReadonlyArray<Destination>, never, R | HttpServerRequest>;
}

const SIGNALS: ReadonlyArray<Signal> = ["traces", "logs", "metrics"];

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Collect OpenTelemetry from browsers and other clients through your own
 * Worker or Function, and forward it to where your backend's telemetry
 * goes, with the backend's own credentials. Clients post OTLP/HTTP to a
 * path ending in `/v1/traces`, `/v1/logs` or `/v1/metrics`; each body is
 * forwarded unchanged, JSON or protobuf.
 *
 * No ingest token ever reaches the client, the client posts to its own
 * origin, and `route` decides where each batch goes.
 *
 * ### Collecting browser traces
 * **Example:** Relay the app's spans through the backend Worker
 * ```typescript
 * import * as Telemetry from "alchemy/Telemetry";
 *
 * const telemetry = Telemetry.relay({ signals: ["traces"] });
 *
 * // in the Worker's fetch handler
 * if (path.startsWith("/api/telemetry/")) return yield* telemetry;
 * ```
 *
 * **Example:** The browser exports to it
 * ```typescript
 * import * as OtlpTracer from "effect/observability/OtlpTracer";
 *
 * OtlpTracer.layer({
 *   url: `${location.origin}/api/telemetry/v1/traces`,
 *   resource: { serviceName: "bank-web" },
 * });
 * ```
 *
 * ### Routing batches
 * **Example:** Send browser traces to their own dataset
 * ```typescript
 * Telemetry.relay({
 *   route: (signal, configured) =>
 *     Effect.succeed(
 *       signal === "traces"
 *         ? configured.map((d) => ({ ...d, headers: { ...d.headers, "x-axiom-dataset": "browser" } }))
 *         : configured,
 *     ),
 * });
 * ```
 *
 * @primitive
 */
export const relay = <R = never>(
  options: RelayOptions<R> = {},
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (request.method !== "POST") return json(405, { error: "OTLP is posted" });
    const signal = SIGNALS.find((s) =>
      new URL(request.url, "http://relay").pathname.endsWith(`/v1/${s}`),
    );
    if (!signal || !(options.signals ?? SIGNALS).includes(signal)) {
      return json(404, { error: "Unknown signal" });
    }
    const maxBytes = options.maxBytes ?? 1_048_576;
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > maxBytes) return json(413, { error: "Too large" });
    if (options.authorize && !(yield* options.authorize)) return json(403, { error: "Forbidden" });

    const body = yield* request.arrayBuffer.pipe(Effect.option);
    if (Option.isNone(body)) return json(400, { error: "Unreadable body" });
    if (body.value.byteLength > maxBytes) return json(413, { error: "Too large" });

    const configured = (yield* configuredDestinations).flatMap(
      (destination): ReadonlyArray<ResolvedSignal> => {
        const target = destination[signal];
        return target ? [target] : [];
      },
    );
    const targets = options.route ? yield* options.route(signal, configured) : configured;
    // Nowhere to send it is not the client's problem: accept and drop.
    if (targets.length === 0) return json(200, {});

    const client = Option.getOrElse(
      yield* Effect.serviceOption(HttpClient.HttpClient),
      () => undefined,
    );
    const contentType = request.headers["content-type"] ?? "application/json";
    const forward = (target: Destination) =>
      Effect.gen(function* () {
        const http =
          client ?? (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)));
        const response = yield* http.execute(
          HttpClientRequest.post(target.url).pipe(
            HttpClientRequest.bodyUint8Array(new Uint8Array(body.value), contentType),
            HttpClientRequest.setHeaders(target.headers ?? {}),
          ),
        );
        return response.status >= 200 && response.status < 300;
      }).pipe(Effect.orElseSucceed(() => false));
    const delivered = yield* Effect.forEach(targets, forward, { concurrency: "unbounded" });
    return delivered.some(Boolean)
      ? json(200, {})
      : json(502, { error: "No destination accepted the batch" });
  });
