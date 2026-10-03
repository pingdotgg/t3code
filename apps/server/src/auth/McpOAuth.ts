import * as NodeCrypto from "node:crypto";

import {
  AuthAccessWriteScope,
  RuntimeMode,
  type RuntimeMode as RuntimeModeType,
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
import { HttpServerRequest } from "effect/unstable/http";

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
 * an unauthenticated caller cannot grow server state. Only loopback redirect
 * URIs are accepted; an https redirect would let anyone mail the owner an
 * approval link that delivers the code to their own server.
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

const MCP_OAUTH_SCOPE = encodeOAuthScope(EnvironmentAuth.MCP_CLIENT_SCOPES);
export const decodeRuntimeMode = Schema.decodeUnknownOption(RuntimeMode);

export interface McpOAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

/** Issuer and MCP resource for the origin this request reached. */
export const requestUrls = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<McpOAuthUrls> =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => ({ issuer: url.origin, resource: `${url.origin}/mcp` })),
  );

export const protectedResourceMetadata = (urls: McpOAuthUrls) => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: [...EnvironmentAuth.MCP_CLIENT_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: "T3 Code",
});

export const authorizationServerMetadata = (urls: McpOAuthUrls) => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [...EnvironmentAuth.MCP_CLIENT_SCOPES],
  authorization_response_iss_parameter_supported: true,
});

const parseLoopbackRedirect = (value: string): URL | undefined => {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      LOOPBACK_HOSTNAMES.has(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** RFC 8252 §7.3: loopback redirects match on everything but the port. */
export const loopbackRedirectMatches = (registered: string, presented: string): boolean => {
  const left = parseLoopbackRedirect(registered);
  const right = parseLoopbackRedirect(presented);
  return (
    left !== undefined &&
    right !== undefined &&
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

const pkceVerifies = (verifier: string, challenge: string): boolean =>
  CODE_VERIFIER_PATTERN.test(verifier) &&
  timingSafeEqualBase64Url(
    NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    challenge,
  );

const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
});
const decodeClientIdPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientIdPayload));

export interface McpOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
}

export type McpOAuthError =
  | { readonly kind: "invalid_client_metadata"; readonly description: string }
  | { readonly kind: "invalid_redirect_uri"; readonly description: string };

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

/** RFC 6749 §5.2 token endpoint errors. */
export class McpOAuthTokenError extends Schema.TaggedError<McpOAuthTokenError>()(
  "McpOAuthTokenError",
  {
    error: Schema.Literals([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unsupported_grant_type",
    ]),
    description: Schema.String,
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
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly runtimeModeCeiling: RuntimeModeType;
  readonly expiresAtMs: number;
}

export type ApprovalMethod =
  | { readonly type: "pairing-code"; readonly code: string }
  | { readonly type: "browser-session"; readonly csrfToken: string };

export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly register: (input: unknown) => Effect.Effect<McpOAuthClient, McpOAuthError>;
    /** Validates an authorize request. Page errors must never redirect. */
    readonly validateAuthorization: (input: {
      readonly urls: McpOAuthUrls;
      readonly params: (name: string) => string | undefined;
    }) => Effect.Effect<AuthorizationRequest, McpOAuthPageError | McpOAuthRedirectError>;
    /** The signed-in owner on this origin, when their browser session may approve. */
    readonly approvingBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
      authorization: AuthorizationRequest,
    ) => Effect.Effect<{ readonly csrfToken: string } | undefined>;
    /** Approves and returns the URL to send the browser to. */
    readonly approve: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly authorization: AuthorizationRequest;
      readonly runtimeModeCeiling: RuntimeModeType;
      readonly method: ApprovalMethod;
    }) => Effect.Effect<string, EnvironmentAuth.ServerAuthMcpApprovalCodeError | McpOAuthPageError>;
    readonly deny: (authorization: AuthorizationRequest) => string;
    readonly exchangeCode: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly urls: McpOAuthUrls;
      readonly params: (name: string) => string | undefined;
    }) => Effect.Effect<
      {
        readonly access_token: string;
        readonly token_type: "Bearer";
        readonly expires_in: number;
        readonly scope: string;
      },
      McpOAuthTokenError
    >;
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

  const signClientId = (name: string, redirectUris: ReadonlyArray<string>) => {
    const body = base64UrlEncode(JSON.stringify({ v: 1, n: name, r: redirectUris }));
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
        Option.map((payload) => ({ clientId, name: payload.n, redirectUris: payload.r })),
      ),
    );
  };

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

  const register: McpOAuth["Service"]["register"] = (input) =>
    Effect.gen(function* () {
      if (typeof input !== "object" || input === null) {
        return yield* Effect.fail<McpOAuthError>({
          kind: "invalid_client_metadata",
          description: "Client metadata must be a JSON object.",
        });
      }
      const metadata = input as Record<string, unknown>;
      const rawName = typeof metadata.client_name === "string" ? metadata.client_name.trim() : "";
      const name = (rawName.length > 0 ? rawName : DEFAULT_CLIENT_NAME).slice(
        0,
        MAX_CLIENT_NAME_LENGTH,
      );
      const redirectUris = metadata.redirect_uris;
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.length > MAX_REDIRECT_URIS ||
        !redirectUris.every((uri): uri is string => typeof uri === "string")
      ) {
        return yield* Effect.fail<McpOAuthError>({
          kind: "invalid_redirect_uri",
          description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
        });
      }
      if (!redirectUris.every((uri) => parseLoopbackRedirect(uri) !== undefined)) {
        return yield* Effect.fail<McpOAuthError>({
          kind: "invalid_redirect_uri",
          description: "Only http://localhost, 127.0.0.1 or [::1] redirect URIs are accepted.",
        });
      }
      if (
        metadata.token_endpoint_auth_method !== undefined &&
        metadata.token_endpoint_auth_method !== "none"
      ) {
        return yield* Effect.fail<McpOAuthError>({
          kind: "invalid_client_metadata",
          description: "Only public clients (token_endpoint_auth_method none) are supported.",
        });
      }
      // Requested grant types and scopes are ignored rather than rejected: RFC 7591 lets
      // the server answer with what it supports, and Claude Code asks for refresh_token.
      return { clientId: signClientId(name, redirectUris), name, redirectUris };
    });

  const validateAuthorization: McpOAuth["Service"]["validateAuthorization"] = ({ urls, params }) =>
    Effect.gen(function* () {
      const client = parseClientId(params("client_id") ?? "");
      if (client === undefined) {
        return yield* new McpOAuthPageError({
          description: "This sign-in link names an unknown app. Start the sign-in again from it.",
        });
      }
      const redirectUri = params("redirect_uri");
      if (
        redirectUri === undefined ||
        parseLoopbackRedirect(redirectUri) === undefined ||
        !client.redirectUris.some((registered) => loopbackRedirectMatches(registered, redirectUri))
      ) {
        return yield* new McpOAuthPageError({
          description: "This sign-in link sends you to an address the app did not register.",
        });
      }
      const state = params("state");
      const fail = (error: McpOAuthRedirectError["error"], description: string) =>
        new McpOAuthRedirectError({
          error,
          description,
          redirectUri,
          ...(state === undefined ? {} : { state }),
        });
      if (params("response_type") !== "code") {
        return yield* fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      const codeChallenge = params("code_challenge");
      if (
        params("code_challenge_method") !== "S256" ||
        codeChallenge === undefined ||
        !CODE_CHALLENGE_PATTERN.test(codeChallenge)
      ) {
        return yield* fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }
      if (!sameResource(urls, params("resource"))) {
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
        EnvironmentAuth.MCP_CLIENT_SCOPES.every((scope) => session.scopes.includes(scope))
          ? { csrfToken: csrfToken(session.sessionId, authorization) }
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const mintCode = (authorization: AuthorizationRequest, runtimeModeCeiling: RuntimeModeType) =>
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
          redirectUri: authorization.redirectUri,
          codeChallenge: authorization.codeChallenge,
          resource: authorization.resource,
          runtimeModeCeiling,
          expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
        });
        return next;
      });
      return code;
    });

  const approve: McpOAuth["Service"]["approve"] = (input) =>
    Effect.gen(function* () {
      if (input.method.type === "pairing-code") {
        yield* environmentAuth.consumeMcpApprovalCode(input.method.code).pipe(
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
          !timingSafeEqualBase64Url(input.method.csrfToken, session.csrfToken)
        ) {
          return yield* new McpOAuthPageError({
            description: "Your session cannot approve this request. Enter a pairing code instead.",
          });
        }
      }
      const code = yield* mintCode(input.authorization, input.runtimeModeCeiling);
      yield* Effect.logInfo("Approved an MCP client sign-in.", {
        client: input.authorization.client.name,
        runtimeModeCeiling: input.runtimeModeCeiling,
        method: input.method.type,
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

  const exchangeCode: McpOAuth["Service"]["exchangeCode"] = ({ request, urls, params }) =>
    Effect.gen(function* () {
      const fail = (error: McpOAuthTokenError["error"], description: string) =>
        new McpOAuthTokenError({ error, description });
      if (params("grant_type") !== "authorization_code") {
        return yield* fail("unsupported_grant_type", "Only authorization_code is supported.");
      }
      const code = params("code");
      const redirectUri = params("redirect_uri");
      const clientId = params("client_id");
      const verifier = params("code_verifier");
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
        !sameResource(urls, params("resource")) ||
        !pkceVerifies(verifier, pending.codeChallenge)
      ) {
        return yield* fail("invalid_grant", "The authorization code is invalid or expired.");
      }
      const issued = yield* environmentAuth
        .issueMcpClientSession({
          label: pending.clientName,
          runtimeModeCeiling: pending.runtimeModeCeiling,
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
        token_type: "Bearer" as const,
        expires_in: Math.max(0, Math.floor((issued.expiresAt.epochMilliseconds - now) / 1000)),
        scope: MCP_OAUTH_SCOPE,
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
export const mcpClientAuthenticatorLayer = Layer.effect(
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
                  runtimeModeCeiling: client.runtimeModeCeiling,
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
