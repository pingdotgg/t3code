// @effect-diagnostics nodeBuiltinImport:off
import {
  PREVIEW_GATEWAY_HTTP_PATH,
  PREVIEW_GATEWAY_TARGET_HEADER,
  PREVIEW_GATEWAY_TICKET_HEADER,
  PREVIEW_GATEWAY_WEBSOCKET_PATH,
  normalizePreviewGatewayDialTarget,
  parsePreviewGatewayTarget,
} from "@t3tools/shared/previewGateway";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { validatePreviewGatewayTicket } from "./GatewayTicket.ts";

const GATEWAY_CONNECT_TIMEOUT = Duration.seconds(10);
const MAX_GATEWAY_HEADER_LENGTH = 16_384;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const GATEWAY_HEADERS = new Set([PREVIEW_GATEWAY_TARGET_HEADER, PREVIEW_GATEWAY_TICKET_HEADER]);

type GatewayKind = "http" | "websocket";

export interface PreviewGatewayTarget {
  readonly url: URL;
  readonly hostHeader: string;
  readonly port: string;
}

export class PreviewGatewayRequestError extends Schema.TaggedErrorClass<PreviewGatewayRequestError>()(
  "PreviewGatewayRequestError",
  {
    status: Schema.Number,
    code: Schema.String,
    detail: Schema.String,
    port: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const isPreviewGatewayRequestError = Schema.is(PreviewGatewayRequestError);

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

export const previewGatewayErrorResponse = (
  error: PreviewGatewayRequestError,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="t3-preview-gateway-error" content="${escapeHtml(error.code)}"${error.port === undefined ? "" : ` data-port="${escapeHtml(error.port)}"`}><title>Preview unavailable</title></head><body><h1>Preview unavailable</h1><p>${escapeHtml(error.detail)}</p></body></html>`,
    {
      status: error.status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
      },
    },
  );

const defaultPortForProtocol = (protocol: string): string =>
  protocol === "https:" || protocol === "wss:" ? "443" : "80";

export const resolvePreviewGatewayTarget = (
  rawTarget: string,
  kind: GatewayKind,
): PreviewGatewayTarget | null => {
  if (rawTarget.length === 0 || rawTarget.length > MAX_GATEWAY_HEADER_LENGTH) {
    return null;
  }
  const protocols = kind === "http" ? new Set(["http:"]) : new Set(["ws:"]);
  const parsed = parsePreviewGatewayTarget(rawTarget, protocols);
  if (
    parsed === null ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    return null;
  }

  const port = parsed.port || defaultPortForProtocol(parsed.protocol);
  if (Number(port) < 1 || Number(port) > 65_535) return null;
  const canonical = normalizePreviewGatewayDialTarget(parsed);
  return {
    url: canonical,
    hostHeader: `localhost:${port}`,
    port,
  };
};

export const sanitizePreviewGatewayHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly hostHeader?: string;
    readonly websocket?: boolean;
  },
): Record<string, string> => {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...GATEWAY_HEADERS]);
  for (const token of headers.connection?.split(",") ?? []) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length > 0) blocked.add(normalized);
  }

  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      blocked.has(normalized) ||
      (options?.websocket === true && normalized.startsWith("sec-websocket-")) ||
      normalized === "host"
    ) {
      continue;
    }
    sanitized[normalized] = value;
  }
  if (options?.hostHeader !== undefined) sanitized.host = options.hostHeader;
  return sanitized;
};

const authenticateGatewayRequest = Effect.fn("PreviewGateway.authenticateRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const ticket = request.headers[PREVIEW_GATEWAY_TICKET_HEADER]?.trim();
  if (!ticket || ticket.length > MAX_GATEWAY_HEADER_LENGTH) {
    return yield* new PreviewGatewayRequestError({
      status: 401,
      code: "authentication-expired",
      detail: `Request a fresh ticket with preview.issueGatewayTicket and send it in ${PREVIEW_GATEWAY_TICKET_HEADER}.`,
    });
  }

  const authorization = yield* validatePreviewGatewayTicket(ticket).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewGatewayRequestError({
          status: 502,
          code: "configuration-failed",
          detail:
            "T3 could not verify the preview gateway ticket. Reconnect to the environment and retry.",
          cause,
        }),
    ),
  );
  if (authorization === null) {
    return yield* new PreviewGatewayRequestError({
      status: 401,
      code: "authentication-expired",
      detail: "The preview gateway ticket is invalid or expired. Request a fresh ticket and retry.",
    });
  }
  return authorization;
});

const targetFromRequest = Effect.fn("PreviewGateway.targetFromRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  kind: GatewayKind,
) {
  const rawTarget = request.headers[PREVIEW_GATEWAY_TARGET_HEADER]?.trim() ?? "";
  const target = resolvePreviewGatewayTarget(rawTarget, kind);
  if (target === null) {
    const example = kind === "http" ? "http://localhost:5173/" : "ws://localhost:5173/";
    return yield* new PreviewGatewayRequestError({
      status: 400,
      code: "configuration-failed",
      detail: `Set ${PREVIEW_GATEWAY_TARGET_HEADER} to a full loopback ${kind} URL such as ${example}.`,
    });
  }
  return target;
});

const upstreamUnavailable = (target: PreviewGatewayTarget, cause?: unknown) =>
  new PreviewGatewayRequestError({
    status: 502,
    code: "upstream-unreachable",
    detail: `T3 could not reach the preview server at ${target.hostHeader}. Start the dev server on that port and make sure it listens on loopback.`,
    port: target.port,
    ...(cause === undefined ? {} : { cause }),
  });

const upstreamTimedOut = (target: PreviewGatewayTarget, cause?: unknown) =>
  new PreviewGatewayRequestError({
    status: 504,
    code: "upstream-unreachable",
    detail: `The preview server at ${target.hostHeader} did not respond within 10 seconds. Check the dev server and retry.`,
    port: target.port,
    ...(cause === undefined ? {} : { cause }),
  });

const authorizeGatewayTarget = (
  authorization: { readonly port: number },
  target: PreviewGatewayTarget,
) =>
  authorization.port === Number(target.port)
    ? Effect.void
    : Effect.fail(
        new PreviewGatewayRequestError({
          status: 403,
          code: "configuration-failed",
          detail: `This preview gateway ticket allows port ${authorization.port}, not port ${target.port}. Request a ticket for the selected port and retry.`,
          port: target.port,
        }),
      );

const proxyHttpRequest = Effect.fn("PreviewGateway.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const authorization = yield* authenticateGatewayRequest(request);
  const target = yield* targetFromRequest(request, "http");
  yield* authorizeGatewayTarget(authorization, target);
  const headers = sanitizePreviewGatewayHeaders(request.headers, {
    hostHeader: target.hostHeader,
  });
  let upstreamRequest = HttpClientRequest.make(request.method)(target.url.toString(), { headers });
  if (HttpMethod.hasBody(request.method)) {
    upstreamRequest = HttpClientRequest.bodyStream(upstreamRequest, request.stream);
  }

  const response = yield* httpClient.execute(upstreamRequest).pipe(
    Effect.timeoutOption(GATEWAY_CONNECT_TIMEOUT),
    Effect.mapError((cause) => upstreamUnavailable(target, cause)),
  );
  if (Option.isNone(response)) return yield* upstreamTimedOut(target);

  const responseHeaders = sanitizePreviewGatewayHeaders(response.value.headers);
  delete responseHeaders["set-cookie"];
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    headers: responseHeaders,
  }).pipe(HttpServerResponse.replaceCookies(response.value.cookies));
});

const requestedWebSocketProtocols = (request: HttpServerRequest.HttpServerRequest): string[] =>
  (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);

const proxyWebSocketRequest = Effect.fn("PreviewGateway.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const authorization = yield* authenticateGatewayRequest(request);
  const target = yield* targetFromRequest(request, "websocket");
  yield* authorizeGatewayTarget(authorization, target);
  if (
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    !request.headers.connection
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade")
  ) {
    return yield* new PreviewGatewayRequestError({
      status: 400,
      code: "configuration-failed",
      detail: "This preview gateway endpoint requires a WebSocket upgrade request.",
    });
  }

  const upstreamHeaders = sanitizePreviewGatewayHeaders(request.headers, {
    hostHeader: target.hostHeader,
    websocket: true,
  });
  const protocols = requestedWebSocketProtocols(request);
  const constructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, requestedProtocols) =>
      new NodeSocket.NodeWS.WebSocket(url, requestedProtocols, {
        headers: upstreamHeaders,
        handshakeTimeout: Duration.toMillis(GATEWAY_CONNECT_TIMEOUT),
      }) as unknown as globalThis.WebSocket,
  );
  const upstream = yield* Socket.makeWebSocket(target.url.toString(), {
    ...(protocols.length > 0 ? { protocols } : {}),
    openTimeout: GATEWAY_CONNECT_TIMEOUT,
  }).pipe(Effect.provide(constructorLayer));

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const upstreamWriter = yield* upstream.writer;
      const clientWriter =
        yield* Deferred.make<
          (
            chunk: string | Uint8Array | Socket.CloseEvent,
          ) => Effect.Effect<void, Socket.SocketError>
        >();
      const upstreamOpened = yield* Deferred.make<void>();
      const upstreamFiber = yield* upstream
        .runRaw((frame) => Effect.flatMap(Deferred.await(clientWriter), (write) => write(frame)), {
          onOpen: Deferred.succeed(upstreamOpened, undefined),
        })
        .pipe(Effect.forkScoped);

      yield* Effect.raceFirst(
        Deferred.await(upstreamOpened),
        Fiber.join(upstreamFiber).pipe(
          Effect.flatMap(() => Effect.fail(upstreamUnavailable(target))),
        ),
      ).pipe(
        Effect.mapError((error) =>
          isPreviewGatewayRequestError(error)
            ? error
            : Socket.isSocketError(error) &&
                error.reason._tag === "SocketOpenError" &&
                error.reason.kind === "Timeout"
              ? upstreamTimedOut(target, error)
              : upstreamUnavailable(target, error),
        ),
      );

      const client = yield* request.upgrade.pipe(
        Effect.mapError(
          (cause) =>
            new PreviewGatewayRequestError({
              status: 400,
              code: "configuration-failed",
              detail:
                "T3 could not upgrade this request to a WebSocket. Retry the preview connection.",
              cause,
            }),
        ),
      );
      const writeToClient = yield* client.writer;
      yield* Deferred.succeed(clientWriter, writeToClient);

      yield* Effect.raceFirst(
        client.runRaw((frame) => upstreamWriter(frame)),
        Fiber.join(upstreamFiber),
      ).pipe(Effect.ignore);
      return HttpServerResponse.empty();
    }),
  );
});

const handleGateway = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, PreviewGatewayRequestError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchTags({
      PreviewGatewayRequestError: (error) => Effect.succeed(previewGatewayErrorResponse(error)),
    }),
  );

export const previewGatewayRouteLayer = Layer.mergeAll(
  HttpRouter.add("*", PREVIEW_GATEWAY_HTTP_PATH, (request) =>
    handleGateway(proxyHttpRequest(request)),
  ),
  HttpRouter.add("GET", PREVIEW_GATEWAY_WEBSOCKET_PATH, (request) =>
    handleGateway(proxyWebSocketRequest(request)),
  ),
).pipe(HttpRouter.provideRequest(NodeHttpClient.layerUndici));
