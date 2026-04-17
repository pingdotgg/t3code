import { Buffer } from "node:buffer";

import { Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { WebPortInspectorShape } from "../Services/WebPortInspector.ts";
import { WebPortInspector, WebPortInspectionError } from "../Services/WebPortInspector.ts";

const DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS = 2_000;
const WEB_PORT_PROBE_MAX_BODY_BYTES = 8_192;

interface WebProbeResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location: string;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function isLikelyWebProbe(result: WebProbeResult | null): boolean {
  if (!result) return false;
  if (result.status === 404) return false;
  if (result.status >= 300 && result.status < 400 && result.location.length > 0) {
    return true;
  }
  const contentType = result.contentType.toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }
  const body = result.body.toLowerCase();
  return body.includes("<!doctype") || body.includes("<html") || body.includes("<head");
}

const collectBodyPreview = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, never> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => ({
        text: "",
        bytes: 0,
      }),
      (state, chunk) => {
        if (state.bytes >= WEB_PORT_PROBE_MAX_BODY_BYTES) {
          return state;
        }

        const chunkBytes = Buffer.byteLength(chunk);
        const remainingBytes = WEB_PORT_PROBE_MAX_BODY_BYTES - state.bytes;
        if (chunkBytes <= remainingBytes) {
          return {
            text: `${state.text}${chunk}`,
            bytes: state.bytes + chunkBytes,
          };
        }

        return {
          text: `${state.text}${Buffer.from(chunk).subarray(0, remainingBytes).toString("utf8")}`,
          bytes: state.bytes + remainingBytes,
        };
      },
    ),
    Effect.map((preview) => preview.text),
    Effect.orElseSucceed(() => ""),
  );

const makeWebPortInspector = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const probeWebPortOnHost = Effect.fn("process.probeWebPortOnHost")(function* (
    port: number,
    host: string,
  ): Effect.fn.Return<WebProbeResult | null, WebPortInspectionError> {
    const request = HttpClientRequest.get(`http://${host}:${port}/`).pipe(
      HttpClientRequest.setHeaders({
        accept: "text/html,application/xhtml+xml;q=1,*/*;q=0.1",
      }),
    );

    return yield* httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const status = response.status;
          const contentType = normalizeHeaderValue(response.headers["content-type"]);
          const location = normalizeHeaderValue(response.headers.location);

          if (
            (status >= 300 && status < 400 && location.length > 0) ||
            contentType.toLowerCase().includes("text/html") ||
            contentType.toLowerCase().includes("application/xhtml+xml")
          ) {
            return {
              status,
              contentType,
              location,
              body: "",
            } satisfies WebProbeResult;
          }

          const body = yield* collectBodyPreview(response.stream);
          return {
            status,
            contentType,
            location,
            body,
          } satisfies WebProbeResult;
        }),
      ),
      Effect.timeoutOption(DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new WebPortInspectionError({
                port,
                host,
                detail: "HTTP probe timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((error) =>
        Schema.is(WebPortInspectionError)(error)
          ? error
          : new WebPortInspectionError({
              port,
              host,
              detail: "Failed to execute HTTP probe request.",
              cause: error,
            }),
      ),
    );
  });

  const inspect: WebPortInspectorShape["inspect"] = Effect.fn("process.inspectWebPort")(function* (
    port: number,
  ) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return yield* new WebPortInspectionError({
        port,
        host: "127.0.0.1",
        detail: "Port must be an integer between 1 and 65535.",
      });
    }

    const ipv4Result = yield* probeWebPortOnHost(port, "127.0.0.1").pipe(Effect.exit);
    if (ipv4Result._tag === "Success" && isLikelyWebProbe(ipv4Result.value)) {
      return true;
    }

    const ipv6Result = yield* probeWebPortOnHost(port, "::1").pipe(Effect.exit);
    if (ipv6Result._tag === "Success" && isLikelyWebProbe(ipv6Result.value)) {
      return true;
    }

    if (ipv4Result._tag === "Success" || ipv6Result._tag === "Success") {
      return false;
    }

    if (ipv6Result._tag === "Failure") {
      return yield* Effect.failCause(ipv6Result.cause);
    }

    return yield* Effect.failCause(ipv4Result.cause);
  });

  return {
    inspect,
  } satisfies WebPortInspectorShape;
});

export const WebPortInspectorLive = Layer.effect(WebPortInspector, makeWebPortInspector);
