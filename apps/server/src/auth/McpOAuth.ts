import {
  AuthAccessWriteScope,
  type AuthMcpApprovalDecision,
  type AuthMcpAuthorizationRequest,
  type AuthMcpAuthorizationServerMetadata,
  type AuthMcpClientRegistration,
  type AuthMcpProtectedResourceMetadata,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  type AuthMcpTokenRequest,
  type AuthMcpTokenResult,
  type AuthMcpClientAccess,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MCP_PEER_LINK_SOFTWARE_ID,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  deriveAuthClientMetadata,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

/**
 * The OAuth authorization server MCP clients (Claude Code, Codex, any agent
 * T3 Code did not launch) use to sign in to this environment's `/mcp`.
 *
 * Every URL is derived from the request's own origin, so the same server
 * answers correctly over loopback, Tailscale Serve and a T3 Connect tunnel.
 * Client registration is stateless: a client id is its signed metadata, so
 * an unauthenticated caller cannot grow server state. Redirects go to a
 * loopback address (a CLI agent on the user's machine) or any https address
 * (a hosted agent); the approval page names where access goes, and the user
 * decides.
 */

const SIGNING_SECRET_NAME = "mcp-oauth-signing-key";
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const DEFAULT_CLIENT_NAME = "MCP client";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const MCP_OAUTH_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

export interface McpOAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

/**
 * Issuer and MCP resource for the origin this request reached: its Host, and
 * https when a proxy says so. A Host that is not a valid authority falls back
 * to localhost, which no client will have asked for.
 */
export const requestUrls = (request: HttpServerRequest.HttpServerRequest): McpOAuthUrls => {
  const origin = Option.match(HttpServerRequest.toURL(request), {
    onNone: () => "http://localhost",
    onSome: (url) => url.origin,
  });
  return { issuer: origin, resource: `${origin}/mcp` };
};

export const protectedResourceMetadata = (
  urls: McpOAuthUrls,
): AuthMcpProtectedResourceMetadata => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: MCP_OAUTH_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "T3 Code",
});

export const authorizationServerMetadata = (
  urls: McpOAuthUrls,
): AuthMcpAuthorizationServerMetadata => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: MCP_OAUTH_SCOPES,
  authorization_response_iss_parameter_supported: true,
});

/** A redirect URI an MCP client may register: loopback http, or any https. */
const parseRedirect = (value: string): URL | undefined => {
  // No fragment, not even an empty one, which `URL.hash` reports as "" (RFC 6749 §3.1.2).
  if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined;
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
    return allowed && url.username === "" && url.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether a presented redirect is one the client registered. Loopback
 * redirects match on everything but the port (RFC 8252 §7.3), since CLI
 * agents listen on whatever port is free; https redirects match exactly.
 */
export const redirectMatches = (registered: string, presented: string): boolean => {
  const left = parseRedirect(registered);
  const right = parseRedirect(presented);
  if (left === undefined || right === undefined) return false;
  if (left.protocol === "https:" || right.protocol === "https:") return left.href === right.href;
  return (
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
};

const sameResource = (urls: McpOAuthUrls, presented: string | undefined): boolean => {
  if (presented === undefined) return true;
  try {
    const url = new URL(presented);
    return url.hash === "" && `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource;
  } catch {
    return false;
  }
};

const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
  /** Registered as another T3 Code environment's peer link. */
  p: Schema.optionalKey(Schema.Literal(1)),
});
const decodeClientIdPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientIdPayload));

export interface McpOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly peerLink: boolean;
}

/** Problems the authorize page shows the user without redirecting anywhere. */
export class McpOAuthPageError extends Schema.TaggedError<McpOAuthPageError>()(
  "McpOAuthPageError",
  { description: Schema.String },
) {
  override get message(): string {
    return this.description;
  }
}

/** Problems reported back to the client through its (validated) redirect URI. */
export class McpOAuthRedirectError extends Schema.TaggedError<McpOAuthRedirectError>()(
  "McpOAuthRedirectError",
  {
    error: Schema.Literals(["invalid_request", "unsupported_response_type", "invalid_target"]),
    description: Schema.String,
    redirectUri: Schema.String,
    state: Schema.optional(Schema.String),
  },
) {}

export interface AuthorizationRequest {
  readonly client: McpOAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly resource: string;
  readonly issuer: string;
}

interface PendingCode {
  readonly clientId: string;
  readonly clientName: string;
  readonly peerLink: boolean;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly access: AuthMcpClientAccess;
  readonly expiresAtMs: number;
}

export type ApprovalDecision = Exclude<AuthMcpApprovalDecision, { readonly _tag: "deny" }>;

export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly register: (
      input: AuthMcpClientRegistration,
    ) => Effect.Effect<McpOAuthClient, AuthMcpRegistrationError>;
    /** Validates an authorize request. Page errors must never redirect. */
    readonly validateAuthorization: (input: {
      readonly urls: McpOAuthUrls;
      readonly request: AuthMcpAuthorizationRequest;
    }) => Effect.Effect<AuthorizationRequest, McpOAuthPageError | McpOAuthRedirectError>;
    /**
     * The signed-in owner on this origin, when their browser session may
     * approve at least read-only access. `approve` checks the chosen access
     * against the session's scopes.
     */
    readonly approvingBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
      authorization: AuthorizationRequest,
    ) => Effect.Effect<
      | { readonly csrfToken: string; readonly scopes: ReadonlyArray<AuthEnvironmentScope> }
      | undefined
    >;
    /** Approves and returns the URL to send the browser to. */
    readonly approve: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly authorization: AuthorizationRequest;
      readonly decision: ApprovalDecision;
    }) => Effect.Effect<string, EnvironmentAuth.ServerAuthMcpApprovalCodeError | McpOAuthPageError>;
    readonly deny: (authorization: AuthorizationRequest) => string;
    readonly exchangeCode: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly urls: McpOAuthUrls;
      readonly token: AuthMcpTokenRequest;
    }) => Effect.Effect<AuthMcpTokenResult, AuthMcpTokenError>;
  }
>()("t3/auth/McpOAuth") {}

/** Appends OAuth response parameters, keeping any the client put in its redirect URI. */
const redirectWith = (redirectUri: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
};

export const redirectForError = (error: McpOAuthRedirectError, issuer: string) =>
  redirectWith(error.redirectUri, {
    error: error.error,
    error_description: error.description,
    state: error.state,
    iss: issuer,
  });

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const signingKey = yield* secretStore
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(Effect.orDie);
  const codes = yield* Ref.make<ReadonlyMap<string, PendingCode>>(new Map());

  const sign = (domain: string, payload: string) => signPayload(`${domain}.${payload}`, signingKey);

  const signClientId = (name: string, redirectUris: ReadonlyArray<string>, peerLink: boolean) => {
    const body = base64UrlEncode(
      JSON.stringify({ v: 1, n: name, r: redirectUris, ...(peerLink ? { p: 1 } : {}) }),
    );
    return `${body}.${sign("mcp-client-id", body)}`;
  };

  const parseClientId = (clientId: string): McpOAuthClient | undefined => {
    const [body, signature, extra] = clientId.split(".");
    if (!body || !signature || extra !== undefined) return undefined;
    if (!timingSafeEqualBase64Url(signature, sign("mcp-client-id", body))) return undefined;
    let json: string;
    try {
      json = base64UrlDecodeUtf8(body);
    } catch {
      return undefined;
    }
    return Option.getOrUndefined(
      decodeClientIdPayload(json).pipe(
        Option.map((payload) => ({
          clientId,
          name: payload.n,
          redirectUris: payload.r,
          peerLink: payload.p === 1,
        })),
      ),
    );
  };

  const pkceVerifies = (verifier: string, challenge: string) =>
    CODE_VERIFIER_PATTERN.test(verifier)
      ? crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(
          Effect.orDie,
          Effect.map((digest) => timingSafeEqualBase64Url(base64UrlEncode(digest), challenge)),
        )
      : Effect.succeed(false);

  const csrfToken = (sessionId: string, authorization: AuthorizationRequest) =>
    sign(
      "mcp-csrf",
      JSON.stringify([
        sessionId,
        authorization.client.clientId,
        authorization.redirectUri,
        authorization.codeChallenge,
      ]),
    );

  const register: McpOAuth["Service"]["register"] = (metadata) =>
    Effect.gen(function* () {
      const rawName = metadata.client_name?.trim() ?? "";
      const name = (rawName.length > 0 ? rawName : DEFAULT_CLIENT_NAME).slice(
        0,
        MAX_CLIENT_NAME_LENGTH,
      );
      const redirectUris = metadata.redirect_uris ?? [];
      if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
        });
      }
      if (!redirectUris.every((uri) => parseRedirect(uri) !== undefined)) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description:
            "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
        });
      }
      // Requested grant types, scopes and token endpoint auth methods are ignored rather
      // than rejected: RFC 7591 lets the server answer with what it supports. Claude Code
      // asks for refresh_token, and hosted agents may ask for a client secret; every client
      // is registered as public and proves itself with PKCE instead.
      const peerLink = metadata.software_id === MCP_PEER_LINK_SOFTWARE_ID;
      return {
        clientId: signClientId(name, redirectUris, peerLink),
        name,
        redirectUris,
        peerLink,
      };
    });

  const validateAuthorization: McpOAuth["Service"]["validateAuthorization"] = ({ urls, request }) =>
    Effect.gen(function* () {
      const client = parseClientId(request.client_id ?? "");
      if (client === undefined) {
        return yield* new McpOAuthPageError({
          description: "This sign-in link names an unknown app. Start the sign-in again from it.",
        });
      }
      const redirectUri = request.redirect_uri;
      if (
        redirectUri === undefined ||
        !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
      ) {
        return yield* new McpOAuthPageError({
          description: "This sign-in link sends you to an address the app did not register.",
        });
      }
      const state = request.state;
      const fail = (error: McpOAuthRedirectError["error"], description: string) =>
        new McpOAuthRedirectError({
          error,
          description,
          redirectUri,
          ...(state === undefined ? {} : { state }),
        });
      if (request.response_type !== "code") {
        return yield* fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      const codeChallenge = request.code_challenge;
      if (
        request.code_challenge_method !== "S256" ||
        codeChallenge === undefined ||
        !CODE_CHALLENGE_PATTERN.test(codeChallenge)
      ) {
        return yield* fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }
      if (!sameResource(urls, request.resource)) {
        return yield* fail(
          "invalid_target",
          `This server only issues tokens for ${urls.resource}.`,
        );
      }
      return {
        client,
        redirectUri,
        codeChallenge,
        state,
        resource: urls.resource,
        issuer: urls.issuer,
      } satisfies AuthorizationRequest;
    });

  const approvingBrowserSession: McpOAuth["Service"]["approvingBrowserSession"] = (
    request,
    authorization,
  ) =>
    environmentAuth.authenticateBrowserSession(request).pipe(
      Effect.map((session) =>
        // Approving manages access, and a session may only hand out scopes it holds.
        session.scopes.includes(AuthAccessWriteScope) &&
        session.scopes.includes(AuthOrchestrationReadScope)
          ? { csrfToken: csrfToken(session.sessionId, authorization), scopes: session.scopes }
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const mintCode = (authorization: AuthorizationRequest, access: AuthMcpClientAccess) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const code = Buffer.from(yield* crypto.randomBytes(32).pipe(Effect.orDie)).toString(
        "base64url",
      );
      yield* Ref.update(codes, (current) => {
        const next = new Map(
          Array.from(current).filter(([, pending]) => pending.expiresAtMs > now),
        );
        next.set(code, {
          clientId: authorization.client.clientId,
          clientName: authorization.client.name,
          peerLink: authorization.client.peerLink,
          redirectUri: authorization.redirectUri,
          codeChallenge: authorization.codeChallenge,
          resource: authorization.resource,
          access,
          expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
        });
        return next;
      });
      return code;
    });

  const approve: McpOAuth["Service"]["approve"] = (input) =>
    Effect.gen(function* () {
      const { decision } = input;
      if (decision._tag === "pairing-code") {
        yield* environmentAuth.consumeMcpApprovalCode(decision.code, decision.access).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
            Effect.logError("MCP approval code check failed.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new McpOAuthPageError({
                    description: "The code could not be checked. Try again.",
                  }),
                ),
              ),
            ),
          ),
        );
      } else {
        const session = yield* approvingBrowserSession(input.request, input.authorization);
        if (
          session === undefined ||
          !timingSafeEqualBase64Url(decision.csrfToken, session.csrfToken) ||
          !EnvironmentAuth.mcpClientScopes(decision.access).every((scope) =>
            session.scopes.includes(scope),
          )
        ) {
          return yield* new McpOAuthPageError({
            description: "Your session cannot approve this request. Enter a pairing code instead.",
          });
        }
      }
      const code = yield* mintCode(input.authorization, decision.access);
      yield* Effect.logInfo("Approved an MCP client sign-in.", {
        client: input.authorization.client.name,
        access: decision.access,
        method: decision._tag,
      });
      return redirectWith(input.authorization.redirectUri, {
        code,
        state: input.authorization.state,
        iss: input.authorization.issuer,
      });
    });

  const deny: McpOAuth["Service"]["deny"] = (authorization) =>
    redirectWith(authorization.redirectUri, {
      error: "access_denied",
      state: authorization.state,
      iss: authorization.issuer,
    });

  const exchangeCode: McpOAuth["Service"]["exchangeCode"] = ({ request, urls, token }) =>
    Effect.gen(function* () {
      const fail = (error: AuthMcpTokenError["error"], description: string) =>
        new AuthMcpTokenError({ error, error_description: description });
      if (token.grant_type !== "authorization_code") {
        return yield* fail("unsupported_grant_type", "Only authorization_code is supported.");
      }
      const { code, redirect_uri: redirectUri, client_id: clientId } = token;
      const verifier = token.code_verifier;
      if (!code || !redirectUri || !clientId || !verifier) {
        return yield* fail(
          "invalid_request",
          "code, redirect_uri, client_id and code_verifier are required.",
        );
      }
      if (parseClientId(clientId) === undefined) {
        return yield* fail("invalid_client", "The client is unknown.");
      }
      // A presented code is spent even when a later check fails (RFC 6749 §4.1.2).
      const pending = yield* Ref.modify(codes, (current) => {
        const found = current.get(code);
        if (found === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(code);
        return [found, next] as const;
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        pending === undefined ||
        pending.expiresAtMs <= now ||
        pending.clientId !== clientId ||
        pending.redirectUri !== redirectUri ||
        pending.resource !== urls.resource ||
        !sameResource(urls, token.resource) ||
        !(yield* pkceVerifies(verifier, pending.codeChallenge))
      ) {
        return yield* fail("invalid_grant", "The authorization code is invalid or expired.");
      }
      const issued = yield* environmentAuth
        .issueMcpClientSession({
          label: pending.clientName,
          access: pending.access,
          peerLink: pending.peerLink,
          client: deriveAuthClientMetadata({ request }),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("Could not issue an MCP client session.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(fail("invalid_grant", "The session could not be issued.")),
              ),
            ),
          ),
        );
      return {
        access_token: issued.token,
        token_type: "Bearer",
        expires_in: Math.max(0, Math.floor((issued.expiresAt.epochMilliseconds - now) / 1000)),
        scope: encodeOAuthScope(EnvironmentAuth.mcpClientScopes(pending.access)),
      };
    });

  return McpOAuth.of({
    register,
    validateAuthorization,
    approvingBrowserSession,
    approve,
    deny,
    exchangeCode,
  });
});

export const layer = Layer.effect(McpOAuth, make);

/**
 * Lets `/mcp` admit OAuth clients. Their scope has no calling thread, and
 * never carries preview or device access: those tools act on the caller's
 * own thread.
 */
export const layerMcpClientAuthenticator = Layer.effect(
  McpHttpServer.McpClientAuthenticator,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    return McpHttpServer.McpClientAuthenticator.of({
      authenticate: (request) =>
        environmentAuth.authenticateMcpClient(request).pipe(
          Effect.flatMap((client) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((issuedAt): McpInvocationContext.McpInvocationScope => ({
                environmentId,
                requestNamespace: `client:${client.sessionId}`,
                thread: undefined,
                client: {
                  sessionId: client.sessionId,
                  label: client.label,
                  access: client.access,
                  linked: client.peerLink,
                },
                capabilities: new Set<McpInvocationContext.McpCapability>([
                  "orchestration",
                  "worktree",
                  "pull-requests",
                ]),
                issuedAt,
              })),
            ),
          ),
          Effect.catch((error) =>
            (EnvironmentAuth.isServerAuthCredentialError(error)
              ? Effect.void
              : Effect.logWarning("MCP client authentication failed.", { cause: error })
            ).pipe(Effect.as(undefined)),
          ),
        ),
    });
  }),
);
