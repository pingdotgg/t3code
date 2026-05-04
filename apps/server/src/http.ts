import Mime from "@effect/platform-node/Mime";
import { Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { decodeOtlpTraceRecords } from "./observability/TraceRecord.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { PreviewManager } from "./preview/Services/PreviewManager.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const PREVIEW_TOKEN_QUERY_PARAM = "previewToken";
const PREVIEW_ROOT_ASSET_REGEX =
  /(["'(=])\/((?:@vite\/|@id\/|@fs\/|node_modules\/|src\/)[^"'()\s]*|__vite_ping|@react-refresh|vite-inject-mocker-entry\.js)(["')\s])/g;

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "b3", "traceparent", "content-type"],
  maxAge: 600,
});

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

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/forma/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, { status: 200 });
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

class PreviewProxyRequestError extends Data.TaggedError("PreviewProxyRequestError")<{
  readonly cause: unknown;
}> {}

class PreviewProxyBodyReadError extends Data.TaggedError("PreviewProxyBodyReadError")<{
  readonly cause: unknown;
}> {}

function buildPreviewScopedAssetPath(
  projectId: string,
  assetPath: string,
  previewToken: string | null,
): string {
  const previewPrefix = `/__preview/${projectId}`;
  const scopedPath = `${previewPrefix}/${assetPath}`;
  if (!previewToken) {
    return scopedPath;
  }
  const separator = assetPath.includes("?") ? "&" : "?";
  return `${scopedPath}${separator}${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(previewToken)}`;
}

function rewritePreviewRuntimeUrls(
  source: string,
  projectId: string,
  previewToken: string | null,
): string {
  return source.replace(
    PREVIEW_ROOT_ASSET_REGEX,
    (_match, prefix: string, assetPath: string, suffix: string) =>
      `${prefix}${buildPreviewScopedAssetPath(projectId, assetPath, previewToken)}${suffix}`,
  );
}

function rewritePreviewResponseBody(
  projectId: string,
  previewToken: string | null,
  contentType: string,
  body: Uint8Array,
): Uint8Array {
  if (!/(text\/html|text\/css|javascript|ecmascript|typescript)/i.test(contentType)) {
    return body;
  }
  const decoded = new TextDecoder().decode(body);
  const rewritten = rewritePreviewRuntimeUrls(decoded, projectId, previewToken);
  if (rewritten === decoded) {
    return body;
  }
  return new TextEncoder().encode(rewritten);
}

function extractPreviewProjectIdFromPathname(pathname: string): string | null {
  const pathMatch = pathname.match(/^\/__preview\/([^/]+)(?:\/|$)/);
  return pathMatch?.[1] ?? null;
}

function resolvePreviewProjectIdFromReferer(
  request: HttpServerRequest.HttpServerRequest,
): string | null {
  const referer = request.headers["referer"] ?? request.headers["referrer"];
  if (!referer) {
    return null;
  }
  try {
    const refererUrl = new URL(referer);
    return extractPreviewProjectIdFromPathname(refererUrl.pathname);
  } catch {
    return null;
  }
}

function resolvePreviewAccessTokenFromUrl(url: URL): string | null {
  const previewToken = url.searchParams.get(PREVIEW_TOKEN_QUERY_PARAM);
  return previewToken && previewToken.trim().length > 0 ? previewToken.trim() : null;
}

function resolvePreviewAccessTokenFromReferer(
  request: HttpServerRequest.HttpServerRequest,
): string | null {
  const referer = request.headers["referer"] ?? request.headers["referrer"];
  if (!referer) {
    return null;
  }
  try {
    const refererUrl = new URL(referer);
    return resolvePreviewAccessTokenFromUrl(refererUrl);
  } catch {
    return null;
  }
}

function stripPreviewTokenFromSearch(search: string): string {
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  searchParams.delete(PREVIEW_TOKEN_QUERY_PARAM);
  const nextSearch = searchParams.toString();
  return nextSearch.length > 0 ? `?${nextSearch}` : "";
}

const authorizePreviewRequest = (
  projectId: string,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const previewManager = yield* PreviewManager;
    const previewToken =
      resolvePreviewAccessTokenFromUrl(url) ?? resolvePreviewAccessTokenFromReferer(request);
    if (previewToken) {
      const isAuthorized = yield* previewManager.authenticateAccessToken(
        projectId as never,
        previewToken,
      );
      if (isAuthorized) {
        return previewToken;
      }
    }
    yield* requireAuthenticatedRequest;
    return previewToken;
  });

const proxyPreviewRequest = (
  projectId: string,
  proxiedPath: string,
  search: string,
  previewToken: string | null,
) =>
  Effect.gen(function* () {
    const previewManager = yield* PreviewManager;
    const target = yield* previewManager.getRuntimeTarget(projectId as never);
    if (!target) {
      return HttpServerResponse.text("Preview runtime not found", { status: 404 });
    }

    const targetUrl = new URL(`${target.baseUrl}/${proxiedPath.replace(/^\/+/, "")}`);
    targetUrl.search = stripPreviewTokenFromSearch(search);
    const response = yield* Effect.tryPromise({
      try: () => fetch(targetUrl),
      catch: (cause) => new PreviewProxyRequestError({ cause }),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          new Response("Preview runtime unavailable", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        ),
      ),
    );

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) => new PreviewProxyBodyReadError({ cause }),
    }).pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))));
    const body = rewritePreviewResponseBody(
      projectId,
      previewToken,
      contentType,
      new Uint8Array(arrayBuffer),
    );
    return HttpServerResponse.uint8Array(body, {
      status: response.status,
      contentType,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  });

const serveStaticOrDevRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);

  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }

  const config = yield* ServerConfig;
  if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
    return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
      status: 302,
    });
  }

  const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
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

  const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    const indexPath = path.resolve(staticRoot, "index.html");
    const indexData = yield* fileSystem
      .readFile(indexPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!indexData) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return HttpServerResponse.uint8Array(indexData, {
      status: 200,
      contentType: "text/html; charset=utf-8",
    });
  }

  const contentType = Mime.getType(filePath) ?? "application/octet-stream";
  const data = yield* fileSystem.readFile(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    return HttpServerResponse.text("Internal Server Error", { status: 500 });
  }

  return HttpServerResponse.uint8Array(data, {
    status: 200,
    contentType,
  });
});

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
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
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const previewProxyRouteLayer = HttpRouter.add(
  "GET",
  "/__preview/:projectId/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const projectId = extractPreviewProjectIdFromPathname(url.value.pathname);
    if (!projectId) {
      return HttpServerResponse.text("Missing projectId parameter", { status: 400 });
    }
    const previewToken = yield* authorizePreviewRequest(projectId, request, url.value);
    const proxiedPath = url.value.pathname.replace(/^\/__preview\/[^/]+\/?/, "");
    return yield* proxyPreviewRequest(projectId, proxiedPath, url.value.search, previewToken);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

function makePreviewAssetProxyRoute(pathPattern: string) {
  return HttpRouter.add(
    "GET",
    pathPattern as never,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }

      const projectId = resolvePreviewProjectIdFromReferer(request);
      if (!projectId) {
        return yield* serveStaticOrDevRequest;
      }

      const previewToken = yield* authorizePreviewRequest(projectId, request, url.value);
      const proxiedPath = url.value.pathname.replace(/^\/+/, "");
      return yield* proxyPreviewRequest(projectId, proxiedPath, url.value.search, previewToken);
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  );
}

export const previewAssetProxyRouteLayer = Layer.mergeAll(
  makePreviewAssetProxyRoute("/@vite/*"),
  makePreviewAssetProxyRoute("/@id/*"),
  makePreviewAssetProxyRoute("/@fs/*"),
  makePreviewAssetProxyRoute("/@react-refresh"),
  makePreviewAssetProxyRoute("/node_modules/*"),
  makePreviewAssetProxyRoute("/src/*"),
  makePreviewAssetProxyRoute("/vite-inject-mocker-entry.js"),
  makePreviewAssetProxyRoute("/__vite_ping"),
);

export const staticAndDevRouteLayer = HttpRouter.add("GET", "*", serveStaticOrDevRequest);
