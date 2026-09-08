// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  FoundResponse,
  InternalServerErrorResponse,
  MethodNotAllowedResponse,
  MovedPermanentlyResponse,
  NoIntentResponse,
  NotFoundResponse,
  NotModifiedResponse,
  OkResponse,
  PermanentRedirectResponse,
  SeeOtherResponse,
  TemporaryRedirectResponse,
} from "../../../shared/responses.ts";
import { mockJaegerBinding } from "../../../shared/tracing.ts";
import {
  flagIsEnabled,
  SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING,
} from "./compatibility-flags.ts";
import { attachCustomHeaders, getAssetHeaders } from "./utils/headers.ts";
import {
  generateRedirectsMatcher,
  staticRedirectsMatcher,
} from "./utils/rules-engine.ts";
import type { AssetConfig } from "../../../shared/types.ts";
import type { Analytics } from "./analytics.ts";
import type EntrypointType from "./worker.ts";
import type { Env } from "./worker.ts";

export const REDIRECTS_VERSION = 1;
export const HEADERS_VERSION = 2;

type AssetIntent = {
  eTag: string;
  status: typeof OkResponse.status | typeof NotFoundResponse.status;
};

export type AssetIntentWithResolver = AssetIntent & { resolver: Resolver };

const getResponseOrAssetIntent = async (
  request: Request,
  env: Env,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
): Promise<Response | AssetIntentWithResolver> => {
  const url = new URL(request.url);
  const { search } = url;

  const redirectResult = handleRedirects(
    env,
    request,
    configuration,
    url.host,
    url.pathname,
    search,
  );
  if (redirectResult instanceof Response) {
    return redirectResult;
  }
  const { proxied, pathname } = redirectResult;

  const decodedPathname = decodePath(pathname);

  const intent = await getIntent(
    decodedPathname,
    request,
    configuration,
    exists,
  );

  if (!intent) {
    const response = proxied ? new NotFoundResponse() : new NoIntentResponse();

    return env.JAEGER.enterSpan("no_intent", (span) => {
      span.setTags({
        decodedPathname,
        configuration: JSON.stringify(configuration),
        proxied,
        status: response.status,
      });

      return response;
    });
  }

  const method = request.method.toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    return env.JAEGER.enterSpan("method_not_allowed", (span) => {
      span.setTags({
        method,
        status: MethodNotAllowedResponse.status,
      });

      return new MethodNotAllowedResponse();
    });
  }

  const decodedDestination = intent.redirect ?? decodedPathname;
  const encodedDestination = encodePath(decodedDestination);

  /**
   * The canonical path we serve an asset at is the decoded and re-encoded version.
   * Thus we need to redirect if that is different from the decoded version.
   * We combine this with other redirects (e.g. for html_handling) to avoid multiple redirects.
   */
  if ((encodedDestination !== pathname && intent.asset) || intent.redirect) {
    return env.JAEGER.enterSpan("redirect", (span) => {
      span.setTags({
        originalPath: pathname,
        location:
          encodedDestination !== pathname
            ? encodedDestination
            : (intent.redirect ?? "<unknown>"),
        status: TemporaryRedirectResponse.status,
      });

      return new TemporaryRedirectResponse(encodedDestination + search);
    });
  }

  if (!intent.asset) {
    return env.JAEGER.enterSpan("unknown_action", (span) => {
      span.setTags({
        pathname,
        status: InternalServerErrorResponse.status,
      });

      return new InternalServerErrorResponse(new Error("Unknown action"));
    });
  }

  return { ...intent.asset, resolver: intent.resolver };
};

const resolveAssetIntentToResponse = async (
  assetIntent: AssetIntentWithResolver,
  request: Request,
  env: Env,
  configuration: Required<AssetConfig>,
  getByETag: typeof EntrypointType.prototype.unstable_getByETag,
  analytics: Analytics,
) => {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  const asset = await env.JAEGER.enterSpan("getByETag", async (span) => {
    span.setTags({
      pathname,
      eTag: assetIntent.eTag,
      status: assetIntent.status,
    });

    return await getByETag(assetIntent.eTag, request);
  });

  const headers = getAssetHeaders(
    assetIntent,
    asset.contentType,
    asset.cacheStatus,
    request,
    configuration,
  );
  analytics.setData({ cacheStatus: asset.cacheStatus });

  const strongETag = `"${assetIntent.eTag}"`;
  const weakETag = `W/${strongETag}`;
  const ifNoneMatch = request.headers.get("If-None-Match") || "";
  if ([weakETag, strongETag].includes(ifNoneMatch)) {
    return env.JAEGER.enterSpan("matched_etag", (span) => {
      span.setTags({
        matchedEtag: ifNoneMatch,
        status: NotModifiedResponse.status,
      });

      return new NotModifiedResponse(null, { headers });
    });
  }

  return env.JAEGER.enterSpan("response", (span) => {
    span.setTags({
      etag: assetIntent.eTag,
      status: assetIntent.status,
      head: method === "HEAD",
    });

    const body = method === "HEAD" ? null : asset.readableStream;
    switch (assetIntent.status) {
      case NotFoundResponse.status:
        return new NotFoundResponse(body, { headers });
      case OkResponse.status:
        return new OkResponse(body, { headers });
    }
  });
};

export const canFetch = async (
  request: Request,
  env: Env,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
): Promise<boolean> => {
  const shouldKeepNotFoundHandling =
    configuration.has_static_routing ||
    (flagIsEnabled(
      configuration,
      SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING,
    ) &&
      request.headers.get("Sec-Fetch-Mode") === "navigate");
  if (!shouldKeepNotFoundHandling) {
    configuration = {
      ...configuration,
      not_found_handling: "none",
    };
  }

  const responseOrAssetIntent = await getResponseOrAssetIntent(
    request,
    env,
    configuration,
    exists,
  );

  if (responseOrAssetIntent instanceof NoIntentResponse) {
    return false;
  }

  return true;
};

export const handleRequest = async (
  request: Request,
  env: Env,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  getByETag: typeof EntrypointType.prototype.unstable_getByETag,
  analytics: Analytics,
) => {
  const responseOrAssetIntent = await getResponseOrAssetIntent(
    request,
    env,
    configuration,
    exists,
  );

  const response =
    responseOrAssetIntent instanceof Response
      ? responseOrAssetIntent
      : await resolveAssetIntentToResponse(
          responseOrAssetIntent,
          request,
          env,
          configuration,
          getByETag,
          analytics,
        );

  return attachCustomHeaders(request, response, configuration, env);
};

type Resolver = "html-handling" | "not-found";
type Intent =
  | {
      asset: AssetIntent;
      redirect: null;
      resolver: Resolver;
    }
  | { asset: null; redirect: string; resolver: Resolver }
  | null;

// TODO: Trace this
export const getIntent = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  skipRedirects = false,
): Promise<Intent> => {
  switch (configuration.html_handling) {
    case "auto-trailing-slash": {
      return htmlHandlingAutoTrailingSlash(
        pathname,
        request,
        configuration,
        exists,
        skipRedirects,
      );
    }
    case "force-trailing-slash": {
      return htmlHandlingForceTrailingSlash(
        pathname,
        request,
        configuration,
        exists,
        skipRedirects,
      );
    }
    case "drop-trailing-slash": {
      return htmlHandlingDropTrailingSlash(
        pathname,
        request,
        configuration,
        exists,
        skipRedirects,
      );
    }
    case "none": {
      return htmlHandlingNone(pathname, request, configuration, exists);
    }
  }
};

const htmlHandlingAutoTrailingSlash = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  skipRedirects: boolean,
): Promise<Intent> => {
  let redirectResult: Intent = null;
  let eTagResult: string | null = null;
  const exactETag = await exists(pathname, request);
  if (pathname.endsWith("/index")) {
    if (exactETag) {
      // there's a binary /index file
      return {
        asset: {
          eTag: exactETag,
          status: OkResponse.status,
        },
        redirect: null,
        resolver: "html-handling",
      };
    } else {
      if (
        (redirectResult = await safeRedirect(
          `${pathname}.html`,
          request,
          pathname.slice(0, -"index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo/index.html exists so redirect to /foo/
        return redirectResult;
      } else if (
        (redirectResult = await safeRedirect(
          `${pathname.slice(0, -"/index".length)}.html`,
          request,
          pathname.slice(0, -"/index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo.html exists so redirect to /foo
        return redirectResult;
      }
    }
  } else if (pathname.endsWith("/index.html")) {
    if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        pathname.slice(0, -"index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo/
      return redirectResult;
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        request,
        pathname.slice(0, -"/index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    }
  } else if (pathname.endsWith("/")) {
    if ((eTagResult = await exists(`${pathname}index.html`, request))) {
      // /foo/index.html exists so serve at /foo/
      return {
        asset: { eTag: eTagResult, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/".length)}.html`,
        request,
        pathname.slice(0, -"/".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    }
  } else if (pathname.endsWith(".html")) {
    if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        pathname.slice(0, -".html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        request,
        `${pathname.slice(0, -".html".length)}/`,
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // request for /foo.html but /foo/index.html exists so redirect to /foo/
      return redirectResult;
    }
  }

  if (exactETag) {
    // there's a binary /foo file
    return {
      asset: { eTag: exactETag, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else if ((eTagResult = await exists(`${pathname}.html`, request))) {
    // foo.html exists so serve at /foo
    return {
      asset: { eTag: eTagResult, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else if (
    (redirectResult = await safeRedirect(
      `${pathname}/index.html`,
      request,
      `${pathname}/`,
      configuration,
      exists,
      skipRedirects,
      "html-handling",
    ))
  ) {
    // /foo/index.html exists so redirect to /foo/
    return redirectResult;
  }

  return notFound(pathname, request, configuration, exists);
};

const htmlHandlingForceTrailingSlash = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  skipRedirects: boolean,
): Promise<Intent> => {
  let redirectResult: Intent = null;
  let eTagResult: string | null = null;
  const exactETag = await exists(pathname, request);
  if (pathname.endsWith("/index")) {
    if (exactETag) {
      // there's a binary /index file
      return {
        asset: { eTag: exactETag, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else {
      if (
        (redirectResult = await safeRedirect(
          `${pathname}.html`,
          request,
          pathname.slice(0, -"index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo/index.html exists so redirect to /foo/
        return redirectResult;
      } else if (
        (redirectResult = await safeRedirect(
          `${pathname.slice(0, -"/index".length)}.html`,
          request,
          pathname.slice(0, -"index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo.html exists so redirect to /foo/
        return redirectResult;
      }
    }
  } else if (pathname.endsWith("/index.html")) {
    if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        pathname.slice(0, -"index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo/
      return redirectResult;
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        request,
        pathname.slice(0, -"index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo/
      return redirectResult;
    }
  } else if (pathname.endsWith("/")) {
    if ((eTagResult = await exists(`${pathname}index.html`, request))) {
      // /foo/index.html exists so serve at /foo/
      return {
        asset: { eTag: eTagResult, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else if (
      (eTagResult = await exists(
        `${pathname.slice(0, -"/".length)}.html`,
        request,
      ))
    ) {
      // /foo.html exists so serve at /foo/
      return {
        asset: { eTag: eTagResult, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    }
  } else if (pathname.endsWith(".html")) {
    if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        `${pathname.slice(0, -".html".length)}/`,
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo/
      return redirectResult;
    } else if (exactETag) {
      // there's both /foo.html and /foo/index.html so we serve /foo.html at /foo.html only
      return {
        asset: { eTag: exactETag, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        request,
        `${pathname.slice(0, -".html".length)}/`,
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo/
      return redirectResult;
    }
  }

  if (exactETag) {
    // there's a binary /foo file
    return {
      asset: { eTag: exactETag, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else if (
    (redirectResult = await safeRedirect(
      `${pathname}.html`,
      request,
      `${pathname}/`,
      configuration,
      exists,
      skipRedirects,
      "html-handling",
    ))
  ) {
    // /foo.html exists so redirect to /foo/
    return redirectResult;
  } else if (
    (redirectResult = await safeRedirect(
      `${pathname}/index.html`,
      request,
      `${pathname}/`,
      configuration,
      exists,
      skipRedirects,
      "html-handling",
    ))
  ) {
    // /foo/index.html exists so redirect to /foo/
    return redirectResult;
  }

  return notFound(pathname, request, configuration, exists);
};

const htmlHandlingDropTrailingSlash = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  skipRedirects: boolean,
): Promise<Intent> => {
  let redirectResult: Intent = null;
  let eTagResult: string | null = null;
  const exactETag = await exists(pathname, request);
  if (pathname.endsWith("/index")) {
    if (exactETag) {
      // there's a binary /index file
      return {
        asset: { eTag: exactETag, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else {
      if (pathname === "/index") {
        if (
          (redirectResult = await safeRedirect(
            "/index.html",
            request,
            "/",
            configuration,
            exists,
            skipRedirects,
            "html-handling",
          ))
        ) {
          return redirectResult;
        }
      } else if (
        (redirectResult = await safeRedirect(
          `${pathname.slice(0, -"/index".length)}.html`,
          request,
          pathname.slice(0, -"/index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo.html exists so redirect to /foo
        return redirectResult;
      } else if (
        (redirectResult = await safeRedirect(
          `${pathname}.html`,
          request,
          pathname.slice(0, -"/index".length),
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        // /foo/index.html exists so redirect to /foo
        return redirectResult;
      }
    }
  } else if (pathname.endsWith("/index.html")) {
    // special handling so you don't drop / if the path is just /
    if (pathname === "/index.html") {
      if (
        (redirectResult = await safeRedirect(
          "/index.html",
          request,
          "/",
          configuration,
          exists,
          skipRedirects,
          "html-handling",
        ))
      ) {
        return redirectResult;
      }
    } else if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        pathname.slice(0, -"/index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo
      return redirectResult;
    } else if (exactETag) {
      // there's both /foo.html and /foo/index.html so we serve /foo/index.html at /foo/index.html only
      return {
        asset: { eTag: exactETag, status: OkResponse.status },
        redirect: null,
        resolver: "html-handling",
      };
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        request,
        pathname.slice(0, -"/index.html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    }
  } else if (pathname.endsWith("/")) {
    if (pathname === "/") {
      if ((eTagResult = await exists("/index.html", request))) {
        // /index.html exists so serve at /
        return {
          asset: { eTag: eTagResult, status: OkResponse.status },
          redirect: null,
          resolver: "html-handling",
        };
      }
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/".length)}.html`,
        request,
        pathname.slice(0, -"/".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -"/".length)}/index.html`,
        request,
        pathname.slice(0, -"/".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo
      return redirectResult;
    }
  } else if (pathname.endsWith(".html")) {
    if (
      (redirectResult = await safeRedirect(
        pathname,
        request,
        pathname.slice(0, -".html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo.html exists so redirect to /foo
      return redirectResult;
    } else if (
      (redirectResult = await safeRedirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        request,
        pathname.slice(0, -".html".length),
        configuration,
        exists,
        skipRedirects,
        "html-handling",
      ))
    ) {
      // /foo/index.html exists so redirect to /foo
      return redirectResult;
    }
  }

  if (exactETag) {
    // there's a binary /foo file
    return {
      asset: { eTag: exactETag, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else if ((eTagResult = await exists(`${pathname}.html`, request))) {
    // /foo.html exists so serve at /foo
    return {
      asset: { eTag: eTagResult, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else if ((eTagResult = await exists(`${pathname}/index.html`, request))) {
    // /foo/index.html exists so serve at /foo
    return {
      asset: { eTag: eTagResult, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  }

  return notFound(pathname, request, configuration, exists);
};

const htmlHandlingNone = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
): Promise<Intent> => {
  const exactETag = await exists(pathname, request);
  if (exactETag) {
    return {
      asset: { eTag: exactETag, status: OkResponse.status },
      redirect: null,
      resolver: "html-handling",
    };
  } else {
    return notFound(pathname, request, configuration, exists);
  }
};

const notFound = async (
  pathname: string,
  request: Request,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
): Promise<Intent> => {
  switch (configuration.not_found_handling) {
    case "single-page-application": {
      const eTag = await exists("/index.html", request);
      if (eTag) {
        return {
          asset: { eTag, status: OkResponse.status },
          redirect: null,
          resolver: "not-found",
        };
      }
      return null;
    }
    case "404-page": {
      let cwd = pathname;
      while (cwd) {
        cwd = cwd.slice(0, cwd.lastIndexOf("/"));
        const eTag = await exists(`${cwd}/404.html`, request);
        if (eTag) {
          return {
            asset: { eTag, status: NotFoundResponse.status },
            redirect: null,
            resolver: "not-found",
          };
        }
      }
      return null;
    }
    case "none":
    default: {
      return null;
    }
  }
};

const safeRedirect = async (
  file: string,
  request: Request,
  destination: string,
  configuration: Required<AssetConfig>,
  exists: typeof EntrypointType.prototype.unstable_exists,
  skip: boolean,
  resolver: Resolver,
): Promise<Intent> => {
  if (skip) {
    return null;
  }

  if (!(await exists(destination, request))) {
    const intent = await getIntent(
      destination,
      request,
      configuration,
      exists,
      true,
    );
    // return only if the eTag matches - i.e. not the 404 case
    if (intent?.asset && intent.asset.eTag === (await exists(file, request))) {
      return {
        asset: null,
        redirect: destination,
        resolver,
      };
    }
  }

  return null;
};
/**
 *
 * +===========================================+===========+======================+
 * |              character type               |  fetch()  | encodeURIComponent() |
 * +===========================================+===========+======================+
 * | unreserved ASCII e.g. a-z                 | unchanged | unchanged            |
 * +-------------------------------------------+-----------+----------------------+
 * | reserved (sometimes encoded)              | unchanged | encoded              |
 * | e.g. [ ] @ $ ! ' ( ) * + , ; = : ? # & %  |           |                      |
 * +-------------------------------------------+-----------+----------------------+
 * | non-ASCII e.g. ü. and space               | encoded   | encoded              |
 * +-------------------------------------------+-----------+----------------------+
 *
 * 1. Decode incoming path to handle non-ASCII characters or optionally encoded characters (e.g. square brackets)
 * 2. Match decoded path to manifest
 * 3. Re-encode the path and redirect if the re-encoded path is different from the original path
 *
 * If the user uploads a file that is already URL-encoded, that is accessible only at the (double) encoded path.
 * e.g. /%5Bboop%5D.html is served at /%255Bboop%255D only
 *
 * */

/**
 * Decode all incoming paths to ensure that we can handle paths with non-ASCII characters.
 */
const decodePath = (pathname: string) => {
  return (
    pathname
      .split("/")
      .map((x) => {
        try {
          const decoded = decodeURIComponent(x);
          return decoded;
        } catch {
          return x;
        }
      })
      .join("/")
      // normalize the path; remove multiple slashes which could lead to same-schema redirects
      .replace(/\/+/g, "/")
  );
};
/**
 * Use the encoded path as the canonical path for sometimes-encoded characters
 * e.g. /[boop] -> /%5Bboop%5D 307
 */
const encodePath = (pathname: string) => {
  return pathname
    .split("/")
    .map((x) => {
      try {
        const encoded = encodeURIComponent(x);
        return encoded;
      } catch {
        return x;
      }
    })
    .join("/");
};

const handleRedirects = (
  env: Env,
  request: Request,
  configuration: Required<AssetConfig>,
  host: string,
  pathname: string,
  search: string,
): { proxied: boolean; pathname: string } | Response => {
  const jaeger = env.JAEGER ?? mockJaegerBinding();
  return jaeger.enterSpan("handle_redirects", (span) => {
    const redirectMatch =
      staticRedirectsMatcher(configuration, host, pathname) ||
      generateRedirectsMatcher(configuration)({ request })[0];

    let proxied = false;
    if (redirectMatch) {
      if (redirectMatch.status === 200) {
        // A 200 redirect means that we are proxying/rewriting to a different asset, for example,
        // a request with url /users/12345 could be pointed to /users/id.html. In order to
        // do this, we overwrite the pathname, and instead match for assets with that url,
        // and importantly, do not use the regular redirect handler - as the url visible to
        // the user does not change
        pathname = new URL(redirectMatch.to, request.url).pathname;
        proxied = true;

        span.setTags({
          matched: true,
          proxied: true,
          new_path: pathname,
          status: redirectMatch.status,
        });
      } else {
        const { status, to } = redirectMatch;
        const destination = new URL(to, request.url);
        const location =
          destination.origin === new URL(request.url).origin
            ? `${destination.pathname}${destination.search || search}${destination.hash}`
            : `${destination.href.slice(0, destination.href.length - (destination.search.length + destination.hash.length))}${
                destination.search ? destination.search : search
              }${destination.hash}`;

        span.setTags({
          matched: true,
          destination: location,
          status,
        });

        switch (status) {
          case MovedPermanentlyResponse.status:
            return new MovedPermanentlyResponse(location);
          case SeeOtherResponse.status:
            return new SeeOtherResponse(location);
          case TemporaryRedirectResponse.status:
            return new TemporaryRedirectResponse(location);
          case PermanentRedirectResponse.status:
            return new PermanentRedirectResponse(location);
          case FoundResponse.status:
          default:
            return new FoundResponse(location);
        }
      }
    } else {
      span.setTags({
        matched: false,
      });
    }

    return { proxied, pathname };
  });
};
