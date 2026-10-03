import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/unstable/http";

import * as McpOAuth from "./McpOAuth.ts";
import { renderApprovalPage, renderErrorPage } from "./mcpOAuthHtml.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const page = (html: string, status = 200) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

const redirectTo = (url: string) =>
  HttpServerResponse.redirect(url, {
    status: 302,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

const oauthJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });

const badRequest = HttpServerResponse.text("Bad Request", { status: 400 });

const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);

/** An unverified client or redirect gets a page; anything else goes back to the client. */
const rejectAuthorization = (
  error: McpOAuth.McpOAuthPageError | McpOAuth.McpOAuthRedirectError,
  issuer: string,
) =>
  error._tag === "McpOAuthPageError"
    ? page(renderErrorPage(error.description), 400)
    : redirectTo(McpOAuth.redirectForError(error, issuer));

const lookup = (params: UrlParams.UrlParams) => (name: string) => {
  const value = Option.getOrUndefined(UrlParams.getFirst(params, name));
  return value === undefined || value.length === 0 ? undefined : value;
};

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
] as const;

const protectedResource = Effect.gen(function* () {
  const urls = yield* requestUrls;
  return Option.isNone(urls)
    ? badRequest
    : oauthJson(McpOAuth.protectedResourceMetadata(urls.value));
});

const authorizationServer = Effect.gen(function* () {
  const urls = yield* requestUrls;
  return Option.isNone(urls)
    ? badRequest
    : oauthJson(McpOAuth.authorizationServerMetadata(urls.value));
});

const register = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const body = yield* request.json.pipe(Effect.option);
  if (Option.isNone(body)) {
    return oauthJson(
      { error: "invalid_client_metadata", error_description: "Expected a JSON body." },
      400,
    );
  }
  return yield* oauth.register(body.value).pipe(
    Effect.map((client) =>
      oauthJson(
        {
          client_id: client.clientId,
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        201,
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(oauthJson({ error: error.kind, error_description: error.description }, 400)),
    ),
  );
});

/** Shows the approval form, or reports a bad request without redirecting to an unverified URI. */
const renderAuthorization = (input: {
  readonly params: (name: string) => string | undefined;
  readonly error?: string;
  readonly runtimeModeCeiling?: RuntimeMode;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const oauth = yield* McpOAuth.McpOAuth;
    const urls = yield* requestUrls;
    if (Option.isNone(urls)) return badRequest;
    const authorization = yield* oauth
      .validateAuthorization({ urls: urls.value, params: input.params })
      .pipe(Effect.result);
    if (Result.isFailure(authorization)) {
      return rejectAuthorization(authorization.failure, urls.value.issuer);
    }
    const session = yield* oauth.approvingBrowserSession(request, authorization.success);
    return page(
      renderApprovalPage({
        clientName: authorization.success.client.name,
        redirectHost: new URL(authorization.success.redirectUri).host,
        environmentHost: new URL(urls.value.issuer).host,
        hiddenParams: AUTHORIZE_PARAMS.flatMap((name) => {
          const value = input.params(name);
          return value === undefined ? [] : [[name, value] as const];
        }),
        ...(session === undefined ? {} : { csrfToken: session.csrfToken }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.runtimeModeCeiling === undefined
          ? {}
          : { runtimeModeCeiling: input.runtimeModeCeiling }),
      }),
      input.error === undefined ? 200 : 400,
    );
  });

const authorizeGet = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return badRequest;
  return yield* renderAuthorization({
    params: lookup(UrlParams.fromInput(url.value.searchParams)),
  });
});

const authorizePost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const urls = yield* requestUrls;
  if (Option.isNone(urls)) return badRequest;
  const form = yield* request.urlParamsBody.pipe(Effect.option);
  if (Option.isNone(form)) return badRequest;
  const params = lookup(form.value);
  const authorization = yield* oauth
    .validateAuthorization({ urls: urls.value, params })
    .pipe(Effect.result);
  if (Result.isFailure(authorization)) {
    return rejectAuthorization(authorization.failure, urls.value.issuer);
  }
  if (params("decision") !== "approve") {
    return redirectTo(oauth.deny(authorization.success));
  }
  const runtimeModeCeiling = Option.getOrUndefined(
    McpOAuth.decodeRuntimeMode(params("runtime_mode")),
  );
  if (runtimeModeCeiling === undefined) {
    return yield* renderAuthorization({ params, error: "Choose what the agent may do." });
  }
  const pairingCode = params("pairing_code");
  const csrfToken = params("csrf_token");
  if (pairingCode === undefined && csrfToken === undefined) {
    return yield* renderAuthorization({
      params,
      runtimeModeCeiling,
      error: "Enter a pairing code.",
    });
  }
  return yield* oauth
    .approve({
      request,
      authorization: authorization.success,
      runtimeModeCeiling,
      method:
        pairingCode !== undefined
          ? { type: "pairing-code", code: pairingCode }
          : { type: "browser-session", csrfToken: csrfToken! },
    })
    .pipe(
      Effect.map(redirectTo),
      Effect.catch((error) =>
        renderAuthorization({ params, runtimeModeCeiling, error: error.message }),
      ),
    );
});

const token = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const oauth = yield* McpOAuth.McpOAuth;
  const urls = yield* requestUrls;
  if (Option.isNone(urls)) return badRequest;
  const form = yield* request.urlParamsBody.pipe(Effect.option);
  if (Option.isNone(form)) {
    return oauthJson({ error: "invalid_request", error_description: "Expected a form body." }, 400);
  }
  return yield* oauth.exchangeCode({ request, urls: urls.value, params: lookup(form.value) }).pipe(
    Effect.map((result) => oauthJson(result)),
    Effect.catch((error) =>
      Effect.succeed(
        oauthJson(
          { error: error.error, error_description: error.description },
          error.error === "invalid_client" ? 401 : 400,
        ),
      ),
    ),
  );
});

/**
 * MCP OAuth discovery, registration, approval and token routes. The service is
 * resolved when the routes are registered, so the layer (not each request)
 * carries the dependency.
 */
export const mcpOAuthRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const oauth = yield* McpOAuth.McpOAuth;
    const add = (
      method: "GET" | "POST",
      path: `/${string}`,
      handler: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest | McpOAuth.McpOAuth
      >,
    ) => router.add(method, path, handler.pipe(Effect.provideService(McpOAuth.McpOAuth, oauth)));
    yield* add("GET", "/.well-known/oauth-protected-resource", protectedResource);
    yield* add("GET", "/.well-known/oauth-protected-resource/mcp", protectedResource);
    yield* add("GET", "/.well-known/oauth-authorization-server", authorizationServer);
    yield* add("POST", "/oauth/mcp/register", register);
    yield* add("GET", "/oauth/mcp/authorize", authorizeGet);
    yield* add("POST", "/oauth/mcp/authorize", authorizePost);
    yield* add("POST", "/oauth/mcp/token", token);
  }),
);
