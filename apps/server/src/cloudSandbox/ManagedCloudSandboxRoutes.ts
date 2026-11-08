import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MANAGED_CLOUD_SANDBOX_PATH,
  ManagedCloudSandboxOperation,
  ManagedCloudSandboxResourceId,
  ManagedCloudSandboxSourceOperation,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as Option from "effect/Option";
import * as CloudSandboxPreview from "./CloudSandboxPreview.ts";
import { CloudSandboxManager } from "./CloudSandboxManager.ts";

const decodeOperation = Schema.decodeUnknownEffect(ManagedCloudSandboxOperation);
const decodeResourceId = Schema.decodeUnknownEffect(ManagedCloudSandboxResourceId);
const decodeSourceOperation = Schema.decodeUnknownEffect(ManagedCloudSandboxSourceOperation);

const authenticateSession = Effect.fn("ManagedCloudSandboxRoutes.authenticateSession")(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.authenticateHttpRequest(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error))
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
  },
);

const authenticate = Effect.fn("ManagedCloudSandboxRoutes.authenticate")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* authenticateSession();
  if (!session.scopes.includes(scope)) return yield* failEnvironmentScopeRequired(scope);
});

const preview = Effect.gen(function* () {
  yield* authenticate(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const input = yield* request.json.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          resourceId: ManagedCloudSandboxResourceId,
          url: Schema.String,
          access: Schema.optionalKey(Schema.Literals(["local", "protected"])),
          close: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    ),
  );
  const service = yield* CloudSandboxPreview.CloudSandboxPreview;
  return yield* service
    .open(input)
    .pipe(
      Effect.flatMap((result) =>
        HttpServerResponse.json(result, { headers: { "cache-control": "no-store" } }),
      ),
    );
});
const previewPorts = Effect.gen(function* () {
  yield* authenticate(AuthOrchestrationReadScope);
  return yield* CloudSandboxPreview.discoveredPorts().pipe(Effect.flatMap(HttpServerResponse.json));
});

const management = Effect.gen(function* () {
  const session = yield* authenticateSession();
  const request = yield* HttpServerRequest.HttpServerRequest;
  const input = yield* request.json.pipe(Effect.flatMap(decodeOperation));
  const read =
    input._tag === "get" ||
    input._tag === "list" ||
    (input._tag === "execute" &&
      ["get", "usage", "recordingStatus"].includes(input.operation._tag));
  const requiredScope = read ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
  if (!session.scopes.includes(requiredScope)) {
    return yield* failEnvironmentScopeRequired(requiredScope);
  }
  const manager = yield* CloudSandboxManager;
  switch (input._tag) {
    case "provision":
      return yield* manager
        .provision(input)
        .pipe(
          Effect.flatMap((route) =>
            HttpServerResponse.json({ _tag: "connection", connection: route.connection }),
          ),
        );
    case "connect":
      return yield* manager
        .connect(input.resourceId)
        .pipe(
          Effect.flatMap((route) =>
            HttpServerResponse.json({ _tag: "connection", connection: route.connection }),
          ),
        );
    case "fork":
      return yield* manager
        .fork(input)
        .pipe(
          Effect.flatMap((route) =>
            HttpServerResponse.json({ _tag: "connection", connection: route.connection }),
          ),
        );
    case "get":
      return yield* manager
        .get(input.resourceId)
        .pipe(
          Effect.flatMap((resource) => HttpServerResponse.json({ _tag: "resource", resource })),
        );
    case "list":
      return yield* manager.list.pipe(
        Effect.flatMap((resources) => HttpServerResponse.json({ _tag: "list", resources })),
      );
    case "execute":
      return yield* manager
        .execute(input.resourceId, input.operation)
        .pipe(Effect.flatMap((result) => HttpServerResponse.json({ _tag: "result", result })));
    case "delete":
      yield* manager.release(input.resourceId);
      return yield* HttpServerResponse.json({ _tag: "deleted" });
    case "disconnect":
      yield* manager.disconnect(input.resourceId);
      return yield* HttpServerResponse.json({ _tag: "disconnected" });
  }
});

const source = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resourceId = yield* decodeResourceId(request.headers["x-t3-cloud-resource"]);
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  const manager = yield* CloudSandboxManager;
  yield* manager.sourceContext(resourceId, token);
  const input = yield* request.json.pipe(Effect.flatMap(decodeSourceOperation));
  return yield* manager
    .executeSource(resourceId, token, input)
    .pipe(Effect.flatMap(HttpServerResponse.json));
});

const requestHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  const dropped = new Set([
    "host",
    "cookie",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "content-length",
    "accept-encoding",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "forwarded",
  ]);
  for (const nominated of request.headers.connection?.split(",") ?? []) {
    const normalized = nominated.trim().toLowerCase();
    if (normalized.length > 0) dropped.add(normalized);
  }
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (value !== undefined && !dropped.has(lowerKey)) headers[lowerKey] = value;
  }
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

const normalizeProxyPathname = (rawPathname: string): string | null => {
  if (rawPathname.startsWith("//") || /%(?:2e|2f|5c)/iu.test(rawPathname)) {
    return null;
  }
  const normalized = new URL(rawPathname, "http://proxy.internal");
  if (normalized.origin !== "http://proxy.internal") return null;
  if (
    !/^\/(?:api(?:\/|$)|ws(?:\/|$)|mcp(?:\/|$)|oauth(?:\/|$)|\.well-known\/)/u.test(
      normalized.pathname,
    )
  ) {
    return null;
  }
  return normalized.pathname;
};

const pumpFrames =
  // Frames are already part of a traced proxy session; a span per frame adds no diagnostic value.
  Effect.fnUntraced(function* (source: Socket.Socket, target: Socket.Writer) {
    const reader = yield* source.reader;
    while (true) yield* target.writeAll(yield* reader.pull);
  });

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = Option.getOrNull(requestUrl(request));
  const match = url?.pathname.match(/^\/api\/cloud-sandboxes\/managed\/([^/]+)\/proxy(\/.*)$/u);
  if (!url || !match) return HttpServerResponse.empty({ status: 404 });
  const resourceId = yield* decodeResourceId(match[1]);
  const pathname = normalizeProxyPathname(match[2]!);
  if (pathname === null) return HttpServerResponse.empty({ status: 404 });
  const manager = yield* CloudSandboxManager;
  // Admission is delegated to the child. This route lookup is in-memory and does no I/O, so an
  // unknown id and a known but unconnected one fail the same way.
  const route = yield* manager.route(resourceId);
  const baseUrl = new URL(route.httpBaseUrl);
  const upstreamUrl = new URL(pathname + url.search, baseUrl);
  if (upstreamUrl.origin !== baseUrl.origin) {
    return HttpServerResponse.empty({ status: 404 });
  }
  const headers = requestHeaders(request, upstreamUrl.origin);
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const upstream = yield* Socket.makeWebSocket(upstreamUrl.toString(), {
      headers,
      ...(protocols?.length ? { protocols } : {}),
      openTimeout: "10 seconds",
    }).pipe(Effect.provide(upstreamWebSocketConstructor));
    const downstream = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const toUpstream = yield* upstream.writer;
        const toDownstream = yield* downstream.writer;
        return yield* Effect.raceFirst(
          pumpFrames(upstream, toDownstream),
          pumpFrames(downstream, toUpstream),
        );
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }
  if (!HttpMethod.isHttpMethod(request.method)) return HttpServerResponse.empty({ status: 405 });
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make(request.method)(upstreamUrl.toString()).pipe(
    HttpClientRequest.setHeaders(headers),
    request.method === "GET" || request.method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* client.execute(upstreamRequest);
  const responseHeaders: Record<string, string> = { "cache-control": "no-store, no-transform" };
  for (const [key, value] of Object.entries(response.headers)) {
    if (
      value !== undefined &&
      ![
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "set-cookie",
      ].includes(key)
    )
      responseHeaders[key] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
  });
});

const artifact = Effect.gen(function* () {
  yield* authenticate(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = Option.getOrNull(requestUrl(request));
  const match = url?.pathname.match(
    /^\/api\/cloud-sandboxes\/managed\/([^/]+)\/recordings\/([^/]+)$/u,
  );
  if (!match) return HttpServerResponse.empty({ status: 404 });
  const resourceId = yield* decodeResourceId(match[1]);
  const recordingId = yield* decodeResourceId(match[2]);
  const manager = yield* CloudSandboxManager;
  const bytes = yield* manager.artifact(resourceId, recordingId);
  return HttpServerResponse.uint8Array(bytes, {
    contentType: "video/mp4",
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${recordingId}.mp4"`,
    },
  });
});

type ManagedRouteError = Effect.Error<
  | typeof management
  | typeof source
  | typeof proxy
  | typeof artifact
  | typeof preview
  | typeof previewPorts
>;
const handleErrors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ManagedRouteError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: (error) => HttpServerResponse.json(error, { status: 401 }),
      EnvironmentInternalError: (error) => HttpServerResponse.json(error, { status: 500 }),
      EnvironmentScopeRequiredError: (error) => HttpServerResponse.json(error, { status: 403 }),
      CloudSandboxManagerError: (error) => {
        const headers =
          error.reason === "rate-limited" && error.rateLimit?.waitMs !== undefined
            ? { "retry-after": String(Math.ceil(error.rateLimit.waitMs / 1000)) }
            : undefined;
        return HttpServerResponse.json(
          { message: error.message },
          {
            status:
              error.reason === "ownership"
                ? 403
                : error.reason === "not-found"
                  ? 404
                  : error.reason === "deleted"
                    ? 410
                    : error.reason === "rate-limited"
                      ? 429
                      : 503,
            ...(headers ? { headers } : {}),
          },
        );
      },
    }),
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Invalid managed cloud request.", { status: 400 }),
    ),
  );

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", `${MANAGED_CLOUD_SANDBOX_PATH}/preview`, handleErrors(preview)),
  HttpRouter.add("GET", "/api/cloud-sandboxes/preview-ports", handleErrors(previewPorts)),
  HttpRouter.add("POST", MANAGED_CLOUD_SANDBOX_PATH, handleErrors(management)),
  HttpRouter.add("POST", "/api/cloud-sandboxes/source", handleErrors(source)),
  HttpRouter.add("*", `${MANAGED_CLOUD_SANDBOX_PATH}/:resourceId/proxy/*`, handleErrors(proxy)),
  HttpRouter.add(
    "GET",
    `${MANAGED_CLOUD_SANDBOX_PATH}/:resourceId/recordings/:recordingId`,
    handleErrors(artifact),
  ),
);
