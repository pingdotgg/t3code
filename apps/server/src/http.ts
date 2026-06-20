import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import {
  ASSET_ROUTE_PREFIX,
  FALLBACK_PROJECT_FAVICON_SVG,
  resolveAsset,
} from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    return HttpRouter.cors({
      ...(devOrigin ? { allowedOrigins: [devOrigin], credentials: true } : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

function errorDiagnosticTag(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }
  if (cause instanceof Error) return cause.name;
  return typeof cause;
}

export class BrowserOtlpTraceDecodeError extends Schema.TaggedErrorClass<BrowserOtlpTraceDecodeError>()(
  "BrowserOtlpTraceDecodeError",
  {
    resourceSpanCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static fromPayload(payload: unknown, cause: unknown): BrowserOtlpTraceDecodeError {
    const resourceSpanCount =
      typeof payload === "object" &&
      payload !== null &&
      "resourceSpans" in payload &&
      Array.isArray(payload.resourceSpans)
        ? payload.resourceSpans.length
        : 0;

    return new BrowserOtlpTraceDecodeError({
      resourceSpanCount,
      cause,
    });
  }

  override get message(): string {
    return `Failed to decode browser OTLP payload with ${this.resourceSpanCount} resource spans.`;
  }
}

export class BrowserOtlpTraceCollectionError extends Schema.TaggedErrorClass<BrowserOtlpTraceCollectionError>()(
  "BrowserOtlpTraceCollectionError",
  {
    recordCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static fromRecords(
    records: ReadonlyArray<unknown>,
    cause: unknown,
  ): BrowserOtlpTraceCollectionError {
    return new BrowserOtlpTraceCollectionError({
      recordCount: records.length,
      cause,
    });
  }

  override get message(): string {
    return `Failed to collect ${this.recordCount} browser OTLP trace records locally.`;
  }
}

export class BrowserOtlpTraceExportError extends Schema.TaggedErrorClass<BrowserOtlpTraceExportError>()(
  "BrowserOtlpTraceExportError",
  {
    collectorUrlInputLength: Schema.Number,
    collectorUrlProtocol: Schema.optionalKey(Schema.String),
    collectorUrlHostname: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCollectorUrl(collectorUrl: string, cause: unknown): BrowserOtlpTraceExportError {
    const diagnostics = getUrlDiagnostics(collectorUrl);
    return new BrowserOtlpTraceExportError({
      collectorUrlInputLength: diagnostics.inputLength,
      ...(diagnostics.protocol === undefined ? {} : { collectorUrlProtocol: diagnostics.protocol }),
      ...(diagnostics.hostname === undefined ? {} : { collectorUrlHostname: diagnostics.hostname }),
      cause,
    });
  }

  override get message(): string {
    const collector =
      this.collectorUrlHostname === undefined
        ? "the configured collector"
        : this.collectorUrlHostname;
    return `Failed to export browser OTLP traces to ${collector} (collector URL input length ${this.collectorUrlInputLength}).`;
  }
}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => BrowserOtlpTraceDecodeError.fromPayload(bodyJson, cause),
    }).pipe(
      Effect.flatMap((records) =>
        browserTraceCollector
          .record(records)
          .pipe(
            Effect.catchDefect((cause) =>
              Effect.fail(BrowserOtlpTraceCollectionError.fromRecords(records, cause)),
            ),
          ),
      ),
      Effect.catchTags({
        BrowserOtlpTraceDecodeError: (error) =>
          Effect.logWarning(error.message, {
            errorTag: error._tag,
            resourceSpanCount: error.resourceSpanCount,
            causeTag: errorDiagnosticTag(error.cause),
          }),
        BrowserOtlpTraceCollectionError: (error) =>
          Effect.logWarning(error.message, {
            errorTag: error._tag,
            recordCount: error.recordCount,
            causeTag: errorDiagnosticTag(error.cause),
          }),
      }),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.mapError((cause) =>
          BrowserOtlpTraceExportError.fromCollectorUrl(otlpTracesUrl, cause),
        ),
        Effect.catchTags({
          BrowserOtlpTraceExportError: (error) =>
            Effect.logWarning(error.message, {
              errorTag: error._tag,
              collectorUrlInputLength: error.collectorUrlInputLength,
              ...(error.collectorUrlProtocol === undefined
                ? {}
                : { collectorUrlProtocol: error.collectorUrlProtocol }),
              ...(error.collectorUrlHostname === undefined
                ? {}
                : { collectorUrlHostname: error.collectorUrlHostname }),
              causeTag: errorDiagnosticTag(error.cause),
            }).pipe(Effect.as(HttpServerResponse.text("Trace export failed.", { status: 502 }))),
        }),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
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

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
