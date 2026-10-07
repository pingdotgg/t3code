import {
  AuthMcpApprovalError,
  type AuthMcpAuthorizationRequest,
  AuthMcpClientAccess,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import { renderErrorPage } from "./mcpOAuthHtml.ts";

/** Where the approval page lives in the web app. */
const APPROVAL_PAGE_PATH = "/connect-agent";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** OAuth responses carry codes, tokens and client ids, none of which may be cached. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

/** Issuer and resource for the origin this request reached. */
const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);

/**
 * Validates the request the approval page forwards. An unverified client or
 * redirect is reported, never redirected; any other problem goes back to the
 * agent through its (verified) redirect URI.
 */
const forwardedAuthorization = (
  oauth: McpOAuth.McpOAuth["Service"],
  request: AuthMcpAuthorizationRequest,
) =>
  Effect.gen(function* () {
    const urls = yield* requestUrls;
    return yield* oauth.validateAuthorization({ urls, request }).pipe(
      Effect.catchTags({
        McpOAuthPageError: (error) =>
          Effect.fail(new AuthMcpApprovalError({ message: error.description })),
        McpOAuthRedirectError: (error) =>
          Effect.succeed({ redirectTo: McpOAuth.redirectForError(error, urls.issuer) }),
      }),
    );
  });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpOAuth",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* McpOAuth.McpOAuth;
    const protectedResource = () =>
      requestUrls.pipe(Effect.map(McpOAuth.protectedResourceMetadata));

    return (
      handlers
        .handle("protectedResource", protectedResource)
        .handle("mcpProtectedResource", protectedResource)
        .handle("authorizationServer", () =>
          requestUrls.pipe(Effect.map(McpOAuth.authorizationServerMetadata)),
        )
        .handle("register", ({ payload }) =>
          oauth.register(payload).pipe(
            Effect.map((client) => ({
              client_id: client.clientId,
              client_name: client.name,
              redirect_uris: client.redirectUris,
              grant_types: ["authorization_code" as const],
              response_types: ["code" as const],
              token_endpoint_auth_method: "none" as const,
            })),
            Effect.tap(() => noStore),
          ),
        )
        // The browser lands here from the agent. A valid request is handed to the
        // web app's approval page with its query intact.
        .handleRaw("authorize", ({ request }) =>
          Effect.gen(function* () {
            const urls = yield* requestUrls;
            const url = new URL(request.url, urls.issuer);
            const authorization = yield* oauth
              .validateAuthorization({ urls, request: Object.fromEntries(url.searchParams) })
              .pipe(Effect.result);
            const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
            if (Result.isSuccess(authorization)) {
              return HttpServerResponse.redirect(`${APPROVAL_PAGE_PATH}${url.search}`, { headers });
            }
            const error = authorization.failure;
            return error._tag === "McpOAuthPageError"
              ? HttpServerResponse.text(renderErrorPage(error.description), {
                  status: 400,
                  contentType: "text/html; charset=utf-8",
                  headers: PAGE_HEADERS,
                })
              : HttpServerResponse.redirect(McpOAuth.redirectForError(error, urls.issuer), {
                  headers,
                });
          }),
        )
        // What the approval page shows, and whether one click may approve.
        .handle("approval", ({ payload, request }) =>
          Effect.gen(function* () {
            const resolved = yield* forwardedAuthorization(oauth, payload);
            if ("redirectTo" in resolved) return resolved;
            const urls = yield* requestUrls;
            const session = yield* oauth.approvingBrowserSession(request, resolved);
            yield* noStore;
            return {
              clientName: resolved.client.name,
              redirectHost: new URL(resolved.redirectUri).host,
              environmentHost: new URL(urls.issuer).host,
              ...(session === undefined
                ? {}
                : {
                    csrfToken: session.csrfToken,
                    oneClickAccess: AuthMcpClientAccess.literals.filter((access) =>
                      EnvironmentAuth.mcpClientScopes(access).every((scope) =>
                        session.scopes.includes(scope),
                      ),
                    ),
                  }),
            };
          }),
        )
        .handle("decision", ({ payload, request }) =>
          Effect.gen(function* () {
            const resolved = yield* forwardedAuthorization(oauth, payload.authorization);
            if ("redirectTo" in resolved) return resolved;
            yield* noStore;
            const { decision } = payload;
            if (decision._tag === "deny") return { redirectTo: oauth.deny(resolved) };
            return yield* oauth.approve({ request, authorization: resolved, decision }).pipe(
              Effect.map((redirectTo) => ({ redirectTo })),
              Effect.mapError((error) => new AuthMcpApprovalError({ message: error.message })),
            );
          }),
        )
        .handle("token", ({ payload, request }) =>
          Effect.gen(function* () {
            yield* noStore;
            return yield* oauth.exchangeCode({ request, urls: yield* requestUrls, token: payload });
          }),
        )
    );
  }),
);
