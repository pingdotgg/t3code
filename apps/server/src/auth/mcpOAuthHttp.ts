import {
  AuthMcpApprovalError,
  AuthMcpAuthorizationRequest,
  AuthMcpClientAccess,
  EnvironmentHttpApi,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

import * as CloudLink from "../cloud/CloudLink.ts";
import { hostedAppUrlConfig } from "../cloud/publicConfig.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpOAuth from "./McpOAuth.ts";
import { renderErrorPage } from "./mcpOAuthHtml.ts";

const APPROVAL_PAGE_PATH = "/connect-agent";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// OAuth responses contain credentials and must not be cached.
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);
const decodeAuthorizationRequest = Schema.decodeEffect(AuthMcpAuthorizationRequest);

/**
 * An unverified client or redirect is reported, never redirected; any other problem goes back to
 * the agent through its (verified) redirect URI.
 */
const forwardedAuthorization =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    oauth: McpOAuth.McpOAuth["Service"],
    request: AuthMcpAuthorizationRequest,
  ) {
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
    const cloudLink = yield* CloudLink.CloudLink;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const hostedAppUrl = yield* hostedAppUrlConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HOSTED_APP_URL),
    );
    // The hosted app returns a code only to the tunnel address, so other origins keep the code field.
    const connectSignIn = (issuer: string) =>
      cloudLink.linkState().pipe(
        Effect.flatMap((state) =>
          state.linked && !state.linkRevoked && state.tunnelHostname === new URL(issuer).hostname
            ? serverEnvironment.getEnvironmentId.pipe(
                Effect.map((environmentId) => Option.some({ environmentId, hostedAppUrl })),
              )
            : Effect.succeedNone,
        ),
        Effect.orElseSucceed(Option.none),
      );
    const protectedResource = () =>
      requestUrls.pipe(Effect.map(McpOAuth.protectedResourceMetadata));

    return handlers
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
      .handleRaw("authorize", ({ request }) =>
        Effect.gen(function* () {
          const urls = yield* requestUrls;
          const url = new URL(request.url, urls.issuer);
          const authorizationRequest = yield* decodeAuthorizationRequest(
            Object.fromEntries(url.searchParams),
          ).pipe(Effect.orDie);
          const authorization = yield* oauth
            .validateAuthorization({ urls, request: authorizationRequest })
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
      .handle("approval", ({ payload, request }) =>
        Effect.gen(function* () {
          const resolved = yield* forwardedAuthorization(oauth, payload);
          if ("redirectTo" in resolved) return resolved;
          const urls = yield* requestUrls;
          const session = yield* oauth.approvingBrowserSession(request, resolved);
          // A link needs a plain pairing code, which T3 Connect does not mint.
          const connect = resolved.client.peerLink
            ? Option.none()
            : yield* connectSignIn(urls.issuer);
          yield* noStore;
          return {
            clientName: resolved.client.name,
            redirectHost: new URL(resolved.redirectUri).host,
            environmentHost: new URL(urls.issuer).host,
            ...(oauth.runtimeModeCeiling === undefined
              ? {}
              : { runtimeModeCeiling: oauth.runtimeModeCeiling }),
            ...(Option.isSome(connect) ? { connectSignIn: connect.value } : {}),
            ...(session === undefined
              ? {}
              : {
                  csrfToken: session.csrfToken,
                  oneClickAccess: AuthMcpClientAccess.literals.filter((access) =>
                    mcpClientScopes(access).every((scope) => session.scopes.includes(scope)),
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
      );
  }),
);
