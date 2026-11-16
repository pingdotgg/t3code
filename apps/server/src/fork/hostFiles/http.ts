import { AuthFilesystemReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX } from "../../assets/AssetAccess.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { assetFileResponse } from "../../http.ts";
import * as HostFiles from "./HostFiles.ts";
import { FRAME_SANDBOX, framePage, listingPage, openPage, signInPage } from "./hostFilesPages.ts";

// Under the asset prefix, so request traces skip the token and Vite's dev proxy forwards it.
const GRANT_ROUTE_PREFIX = `${ASSET_ROUTE_PREFIX}/host-files`;
// Request traces redact a query parameter by this name.
const OPEN_PROOF_PARAM = "sig";
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-src *; frame-ancestors 'self'",
};
const MINTING_FETCH_SITES: ReadonlySet<string | undefined> = new Set(["same-origin", "none"]);

type Access = "allowed" | "signedOut" | "forbidden";

const htmlPage = (status: number, html: string) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

const plain = (status: number, text: string) =>
  HttpServerResponse.text(text, { status, headers: BASE_HEADERS });

const splitUrl = (request: HttpServerRequest.HttpServerRequest) => {
  const query = request.url.indexOf("?");
  return query === -1
    ? { rawPath: request.url, search: new URLSearchParams() }
    : {
        rawPath: request.url.slice(0, query),
        search: new URLSearchParams(request.url.slice(query + 1)),
      };
};

const authorize = Effect.fn("HostFilesHttp.authorize")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* auth.authenticateHttpRequest(request).pipe(
    Effect.map((session): Access =>
      session.scopes.includes(AuthFilesystemReadScope) ? "allowed" : "forbidden",
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
      Effect.succeed<Access>("signedOut"),
    ),
  );
});

const kindHeaders = (kind: HostFiles.FileKind): Record<string, string> => {
  switch (kind._tag) {
    case "Html":
      return {
        ...BASE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `sandbox ${FRAME_SANDBOX}`,
      };
    case "Typed":
      return { ...BASE_HEADERS, "Content-Type": kind.mimeType };
    case "Text":
      return {
        ...BASE_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      };
    case "Download":
      return BASE_HEADERS;
  }
};

const fileResponse = Effect.fn("HostFilesHttp.fileResponse")(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: HostFiles.FileTarget,
) {
  const path = yield* Path.Path;
  const response = yield* assetFileResponse(
    {
      path: target.path,
      file: target.file,
      ...(target.kind._tag === "Download"
        ? { download: true, fileName: path.basename(target.path) }
        : {}),
    },
    request.method === "GET" ? request.headers.range : undefined,
    request.headers["if-range"],
    request.method === "HEAD" ? "HEAD" : "GET",
  );
  return HttpServerResponse.setHeaders(response, kindHeaders(target.kind));
});

const framedHtml = Effect.fn("HostFilesHttp.framedHtml")(function* (
  request: HttpServerRequest.HttpServerRequest,
  policy: HostFiles.Policy,
  target: HostFiles.FileTarget,
) {
  const path = yield* Path.Path;
  const { rawPath, search } = splitUrl(request);
  const proof = search.get(OPEN_PROOF_PARAM);
  // Browsers send no Sec-Fetch-Site over plain HTTP; there the Open page's signed link stands in.
  const trusted =
    MINTING_FETCH_SITES.has(request.headers["sec-fetch-site"]) ||
    (proof !== null && (yield* HostFiles.verifyOpenProof(rawPath, proof)));
  if (!trusted) {
    const href = `${rawPath}?${OPEN_PROOF_PARAM}=${yield* HostFiles.signOpenProof(rawPath)}`;
    return htmlPage(200, openPage({ title: path.basename(target.path), href }));
  }
  const grant = yield* HostFiles.mintGrant(policy, target.path);
  const src = `${GRANT_ROUTE_PREFIX}/${grant.token}/${encodeURIComponent(grant.fileName.toWellFormed())}`;
  return htmlPage(200, framePage({ title: grant.fileName, src }));
});

const serveAbsolute = Effect.fn("HostFilesHttp.serveAbsolute")(
  function* (policy: HostFiles.Policy) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const access = yield* authorize(request);
    if (access === "signedOut") return htmlPage(401, signInPage);
    if (access === "forbidden") return plain(403, "Forbidden");
    const target = yield* HostFiles.openPath(policy, splitUrl(request).rawPath);
    switch (target._tag) {
      case "NotFound":
        return plain(404, "Not Found");
      case "AddSlash":
        return HttpServerResponse.redirect(target.location, { status: 302, headers: BASE_HEADERS });
      case "Listing":
        return htmlPage(200, listingPage(target));
      case "File":
        return target.kind._tag === "Html"
          ? yield* framedHtml(request, policy, target)
          : yield* fileResponse(request, target);
    }
  },
  Effect.tapError((cause) => Effect.logWarning("Failed to serve a host file.", { cause })),
  Effect.orElseSucceed(() => plain(500, "Internal Server Error")),
);

const serveGrant = Effect.fn("HostFilesHttp.serveGrant")(
  function* (policy: HostFiles.Policy) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { rawPath } = splitUrl(request);
    // The router also matched other letter cases and doubled slashes.
    if (!rawPath.startsWith(`${GRANT_ROUTE_PREFIX}/`)) return plain(404, "Not Found");
    const rest = rawPath.slice(GRANT_ROUTE_PREFIX.length + 1);
    const separator = rest.indexOf("/");
    if (separator <= 0) return plain(404, "Not Found");
    const target = yield* HostFiles.openGrantPath(
      policy,
      rest.slice(0, separator),
      rest.slice(separator + 1),
    );
    switch (target._tag) {
      case "NotFound":
        return plain(404, "Not Found");
      case "AddSlash":
        return HttpServerResponse.redirect(target.location, { status: 302, headers: BASE_HEADERS });
      case "File":
        return yield* fileResponse(request, target);
    }
  },
  Effect.tapError((cause) => Effect.logWarning("Failed to serve a host file grant.", { cause })),
  Effect.orElseSucceed(() => plain(500, "Internal Server Error")),
);

/** The router prefers these static prefixes over the app's `*` route, in either order. */
export const layerWithPolicy = (policy: HostFiles.Policy) =>
  Layer.mergeAll(
    HttpRouter.add("GET", `${GRANT_ROUTE_PREFIX}/*`, serveGrant(policy)),
    // The router adds the bare prefix for "/*" itself, and reads "::" as a literal colon.
    ...policy.roots.map((root) =>
      HttpRouter.add(
        "GET",
        `${root.urlPrefix.replaceAll(":", "::") as `/${string}`}/*`,
        serveAbsolute(policy),
      ),
    ),
  );

export const layer = Layer.unwrap(
  HostFiles.fileRoots.pipe(Effect.flatMap(HostFiles.makePolicy), Effect.map(layerWithPolicy)),
);
