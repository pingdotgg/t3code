import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { buildServerAdvertisedEndpoints } from "./advertisedEndpoints.ts";
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import {
  ASSET_ROUTE_PREFIX,
  FALLBACK_PROJECT_FAVICON_SVG,
  resolveAsset,
} from "./assets/AssetAccess.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import { annotateEnvironmentRequest } from "./auth/http.ts";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { CLOUD_MANAGED_ENDPOINT, decodeManagedEndpoint } from "./cloud/config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import {
  isLoopbackHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";
import * as TailnetAccess from "./tailnetAccess.ts";

export const apiCorsLayer = HttpRouter.cors({
  allowedMethods: browserApiCorsAllowedMethods,
  allowedHeaders: browserApiCorsAllowedHeaders,
  maxAge: 600,
});

const GZIP_MIN_BYTES = 1024;

function acceptsGzip(value: string | undefined): boolean {
  if (!value) return false;

  const accepted = new Map(
    value.split(",").map((entry) => {
      const [coding = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(.+)$/)?.[1])
        .find((parameter) => parameter !== undefined);
      return [coding, quality === undefined ? 1 : Number(quality)] as const;
    }),
  );
  return (accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0;
}

function varyByAcceptEncoding(value: string | undefined): string {
  if (!value) return "Accept-Encoding";
  const values = new Set(value.split(",").map((entry) => entry.trim().toLowerCase()));
  return values.has("*") || values.has("accept-encoding") ? value : `${value}, Accept-Encoding`;
}

const compressHttpResponse = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
  acceptEncoding: string | undefined,
) {
  const body = response.body;
  if (
    body._tag !== "Uint8Array" ||
    body.contentLength < GZIP_MIN_BYTES ||
    !body.contentType.startsWith("application/json") ||
    response.headers["content-encoding"]
  ) {
    return response;
  }

  const variedResponse = HttpServerResponse.setHeader(
    response,
    "vary",
    varyByAcceptEncoding(response.headers.vary),
  );
  if (!acceptsGzip(acceptEncoding)) return variedResponse;

  const compression = yield* HttpResponseCompression.HttpResponseCompression;
  const headers = Headers.set(
    Headers.remove(variedResponse.headers, "content-length"),
    "content-encoding",
    "gzip",
  );
  return compression.gzip(body.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    cookies: response.cookies,
    contentType: body.contentType,
  });
});

export const httpCompressionLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(
      Effect.all([httpEffect, HttpServerRequest.HttpServerRequest]),
      ([response, request]) => compressHttpResponse(response, request.headers["accept-encoding"]),
    ),
  { global: true },
);

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const tailnetAccess = yield* TailnetAccess.TailnetAccess;
    const httpServer = yield* HttpServer.HttpServer;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const descriptor = yield* serverEnvironment.getDescriptor;
        const tailnetHttpsBaseUrl = yield* tailnetAccess.getTailnetHttpsBaseUrl;
        const managedEndpoint = yield* secrets.get(CLOUD_MANAGED_ENDPOINT).pipe(
          Effect.map((stored) =>
            Option.flatMap(stored, (bytes) =>
              decodeManagedEndpoint(new TextDecoder().decode(bytes)),
            ),
          ),
          Effect.tapError((cause) =>
            Effect.logWarning("Could not read the managed remote endpoint", { cause }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );
        return {
          ...descriptor,
          advertisedEndpoints: buildServerAdvertisedEndpoints({
            managedEndpoint: Option.getOrNull(managedEndpoint),
            tailnetHttpsBaseUrl,
            directHttpBaseUrl: resolveHeadlessConnectionString(
              serverConfig.host,
              resolveListeningPort(httpServer.address, serverConfig.port),
            ),
            directReachability: isLoopbackHost(serverConfig.host) ? "loopback" : "lan",
          }),
        };
      }, traceRelayRequest),
    );
  }),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "project-favicon-fallback") {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);
