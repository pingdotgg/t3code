/**
 * Component preview HTTP proxy routes.
 *
 * The component preview harness runs as a loopback Vite dev server per
 * project. These routes expose it to clients under
 * `/__component-preview/:projectId/*`, rewriting root-absolute Vite asset
 * URLs so module graphs keep resolving through the proxy. Requests are
 * authorized either by a short-lived preview access token (issued over the
 * authenticated RPC channel) or by a normal authenticated session.
 *
 * @module componentPreviewHttp
 */
// @effect-diagnostics globalFetch:off - the proxy forwards requests to the loopback Vite server directly.
// @effect-diagnostics globalFetchInEffect:off - the proxy forwards requests to the loopback Vite server directly.
import type { ProjectId } from "@t3tools/contracts";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope, serveStaticOrDevRequest } from "../http.ts";
import { ComponentPreviewManager } from "./Services/ComponentPreviewManager.ts";

const COMPONENT_PREVIEW_TOKEN_QUERY_PARAM = "componentPreviewToken";
const COMPONENT_PREVIEW_PATH_PREFIX = "/__component-preview";
const COMPONENT_PREVIEW_ROOT_ASSET_REGEX =
  /(["'(=])\/((?:@vite\/|@id\/|@fs\/|node_modules\/|src\/)[^"'()\s]*|__vite_ping|@react-refresh|vite-inject-mocker-entry\.js)(["')\s])/g;

class ComponentPreviewProxyRequestError extends Data.TaggedError(
  "ComponentPreviewProxyRequestError",
)<{
  readonly cause: unknown;
}> {}

class ComponentPreviewProxyBodyReadError extends Data.TaggedError(
  "ComponentPreviewProxyBodyReadError",
)<{
  readonly cause: unknown;
}> {}

function buildPreviewScopedAssetPath(
  projectId: string,
  assetPath: string,
  previewToken: string | null,
): string {
  const previewPrefix = `${COMPONENT_PREVIEW_PATH_PREFIX}/${projectId}`;
  const scopedPath = `${previewPrefix}/${assetPath}`;
  if (!previewToken) {
    return scopedPath;
  }
  const separator = assetPath.includes("?") ? "&" : "?";
  return `${scopedPath}${separator}${COMPONENT_PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(previewToken)}`;
}

function rewritePreviewRuntimeUrls(
  source: string,
  projectId: string,
  previewToken: string | null,
): string {
  return source.replace(
    COMPONENT_PREVIEW_ROOT_ASSET_REGEX,
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
  const isRewritableContentType =
    contentType.includes("text/html") ||
    contentType.includes("javascript") ||
    contentType.includes("text/css");
  if (!isRewritableContentType) {
    return body;
  }
  const decoded = new TextDecoder().decode(body);
  const rewritten = rewritePreviewRuntimeUrls(decoded, projectId, previewToken);
  return new TextEncoder().encode(rewritten);
}

function extractPreviewProjectIdFromPathname(pathname: string): string | null {
  const pathMatch = pathname.match(/^\/__component-preview\/([^/]+)(?:\/|$)/);
  return pathMatch?.[1] ?? null;
}

function resolvePreviewProjectIdFromReferer(
  request: HttpServerRequest.HttpServerRequest,
): string | null {
  const referer = request.headers.referer ?? request.headers.referrer;
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
  const previewToken = url.searchParams.get(COMPONENT_PREVIEW_TOKEN_QUERY_PARAM);
  return previewToken && previewToken.trim().length > 0 ? previewToken.trim() : null;
}

function resolvePreviewAccessTokenFromReferer(
  request: HttpServerRequest.HttpServerRequest,
): string | null {
  const referer = request.headers.referer ?? request.headers.referrer;
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
  const searchParams = new URLSearchParams(search);
  searchParams.delete(COMPONENT_PREVIEW_TOKEN_QUERY_PARAM);
  const nextSearch = searchParams.toString();
  return nextSearch.length > 0 ? `?${nextSearch}` : "";
}

const authorizePreviewRequest = (
  projectId: string,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const componentPreviewManager = yield* ComponentPreviewManager;
    const previewToken =
      resolvePreviewAccessTokenFromUrl(url) ?? resolvePreviewAccessTokenFromReferer(request);
    if (previewToken) {
      const isAuthorized = yield* componentPreviewManager.authenticateAccessToken(
        projectId as ProjectId,
        previewToken,
      );
      if (isAuthorized) {
        return previewToken;
      }
    }
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return previewToken;
  });

const proxyPreviewRequest = (
  projectId: string,
  proxiedPath: string,
  search: string,
  previewToken: string | null,
) =>
  Effect.gen(function* () {
    const componentPreviewManager = yield* ComponentPreviewManager;
    const target = yield* componentPreviewManager.getRuntimeTarget(projectId as ProjectId);
    if (!target) {
      return HttpServerResponse.text("Component preview runtime not found", { status: 404 });
    }

    const targetUrl = new URL(`${target.baseUrl}/${proxiedPath.replace(/^\/+/, "")}`);
    targetUrl.search = stripPreviewTokenFromSearch(search);
    const response = yield* Effect.tryPromise({
      try: () => fetch(targetUrl),
      catch: (cause) => new ComponentPreviewProxyRequestError({ cause }),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          new Response("Component preview runtime unavailable", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        ),
      ),
    );

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) => new ComponentPreviewProxyBodyReadError({ cause }),
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

export const componentPreviewProxyRouteLayer = HttpRouter.add(
  "GET",
  `${COMPONENT_PREVIEW_PATH_PREFIX}/:projectId/*`,
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
    const proxiedPath = url.value.pathname.replace(/^\/__component-preview\/[^/]+\/?/, "");
    return yield* proxyPreviewRequest(projectId, proxiedPath, url.value.search, previewToken);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
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
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );
}

export const componentPreviewAssetProxyRouteLayer = Layer.mergeAll(
  makePreviewAssetProxyRoute("/@vite/*"),
  makePreviewAssetProxyRoute("/@id/*"),
  makePreviewAssetProxyRoute("/@fs/*"),
  makePreviewAssetProxyRoute("/@react-refresh"),
  makePreviewAssetProxyRoute("/node_modules/*"),
  makePreviewAssetProxyRoute("/src/*"),
  makePreviewAssetProxyRoute("/vite-inject-mocker-entry.js"),
  makePreviewAssetProxyRoute("/__vite_ping"),
);
