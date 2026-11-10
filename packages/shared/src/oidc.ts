import * as Schema from "effect/Schema";
// OpenID Connect client helpers shared by the web app, the mobile app, and the CLI.
// The relay accepts the ID token as the bearer, so clients need no provider-specific access
// token audience. The relay verifies the signature; clients only read the claims.

export const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string | null;
}

export interface OidcIdTokenClaims {
  readonly sub: string;
  readonly iss: string;
  readonly exp: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly name?: string;
  readonly preferred_username?: string;
}

export interface OidcTokens {
  readonly idToken: string;
  readonly refreshToken: string | null;
  /** The ID token's own expiry, which is what the relay checks. */
  readonly expiresAtEpochMs: number;
  readonly claims: OidcIdTokenClaims;
}

export class OidcError extends Schema.TaggedError<OidcError>()("OidcError", {
  code: Schema.Literals([
    "discovery_failed",
    "issuer_mismatch",
    "insecure_endpoint",
    "token_request_failed",
    "missing_id_token",
    "invalid_id_token",
    "nonce_mismatch",
  ]),
  message: Schema.String,
  /** HTTP status of a failed token request. */
  status: Schema.optional(Schema.Number),
  /** OAuth `error` code from a rejected token request, e.g. `invalid_grant`. */
  oauthError: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Endpoints carry codes and tokens, so they must be HTTPS; loopback HTTP is for local development.
const isSecureEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname))
    );
  } catch {
    return false;
  }
};

export const OIDC_CALLBACK_PATH = "/oidc/callback";

/** The desktop app's OS-delivered redirect back from the identity provider (RFC 8252 private-use scheme). */
export function isDesktopOidcCallbackUrl(value: string | undefined): boolean {
  if (!value || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "t3code:" || url.protocol === "t3code-dev:") &&
    url.host === "app" &&
    url.pathname === OIDC_CALLBACK_PATH
  );
}

export const oidcDiscoveryUrl = (issuer: string): string =>
  `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;

const readString = (document: Record<string, unknown>, key: string): string | null => {
  const value = document[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The issuer must equal the configured string exactly, including any path prefix. */
export function parseOidcMetadata(issuer: string, body: unknown): OidcMetadata {
  const document = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (document.issuer !== issuer) {
    throw new OidcError({
      code: "issuer_mismatch",
      message: "The OIDC discovery issuer does not match the configured one.",
    });
  }
  const authorizationEndpoint = readString(document, "authorization_endpoint");
  const tokenEndpoint = readString(document, "token_endpoint");
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    throw new OidcError({
      code: "discovery_failed",
      message: "OIDC discovery has no authorization or token endpoint.",
    });
  }
  const deviceAuthorizationEndpoint = readString(document, "device_authorization_endpoint");
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, deviceAuthorizationEndpoint]) {
    if (endpoint !== null && !isSecureEndpoint(endpoint)) {
      throw new OidcError({ code: "insecure_endpoint", message: "OIDC endpoints must use HTTPS." });
    }
  }
  return { issuer, authorizationEndpoint, tokenEndpoint, deviceAuthorizationEndpoint };
}

export async function discoverOidc(
  issuer: string,
  fetchImpl: FetchLike = fetch,
): Promise<OidcMetadata> {
  const response = await fetchImpl(oidcDiscoveryUrl(issuer));
  if (!response.ok) {
    throw new OidcError({
      code: "discovery_failed",
      message: `OIDC discovery returned ${response.status}.`,
      status: response.status,
    });
  }
  return parseOidcMetadata(issuer, await response.json());
}

export const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const base64UrlDecodeToString = (value: string): string => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

/** What sign-in needs from Web Crypto. React Native has no global `crypto` and passes its own. */
export interface OidcCrypto {
  readonly randomBytes: (byteLength: number) => Uint8Array;
  readonly sha256: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
}

const webCrypto: OidcCrypto = {
  randomBytes: (byteLength) => crypto.getRandomValues(new Uint8Array(byteLength)),
  sha256: (data) => crypto.subtle.digest("SHA-256", data),
};

export const randomToken = (byteLength = 32, cryptoImpl: OidcCrypto = webCrypto): string =>
  base64UrlEncode(cryptoImpl.randomBytes(byteLength));

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export async function createPkcePair(
  verifier?: string,
  cryptoImpl: OidcCrypto = webCrypto,
): Promise<PkcePair> {
  const value = verifier ?? randomToken(32, cryptoImpl);
  const digest = await cryptoImpl.sha256(new TextEncoder().encode(value));
  return { verifier: value, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", (input.scopes ?? OIDC_SCOPES).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function decodeIdTokenClaims(idToken: string): OidcIdTokenClaims {
  const payload = idToken.split(".")[1];
  if (payload === undefined) {
    throw new OidcError({ code: "invalid_id_token", message: "The ID token is not a JWT." });
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecodeToString(payload)) as Record<string, unknown>;
  } catch (cause) {
    throw new OidcError({
      code: "invalid_id_token",
      message: "The ID token payload is not valid JSON.",
      cause,
    });
  }
  const { sub, iss, exp } = claims;
  if (typeof sub !== "string" || typeof iss !== "string" || typeof exp !== "number") {
    throw new OidcError({
      code: "invalid_id_token",
      message: "The ID token lacks sub, iss, or exp.",
    });
  }
  const optionalString = (key: string): { [key: string]: string } =>
    typeof claims[key] === "string" ? { [key]: claims[key] as string } : {};
  return {
    sub,
    iss,
    exp,
    ...optionalString("nonce"),
    ...optionalString("email"),
    ...optionalString("name"),
    ...optionalString("preferred_username"),
  };
}

/** A person-readable label for the signed-in account. */
export const oidcAccountLabel = (claims: OidcIdTokenClaims): string =>
  claims.email ?? claims.preferred_username ?? claims.name ?? claims.sub;

const ID_TOKEN_REFRESH_SKEW_MS = 60_000;

export const isIdTokenFresh = (
  tokens: Pick<OidcTokens, "expiresAtEpochMs">,
  now: number,
): boolean => tokens.expiresAtEpochMs - ID_TOKEN_REFRESH_SKEW_MS > now;

async function requestTokens(
  metadata: OidcMetadata,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ readonly idToken: string; readonly refreshToken: string | null }> {
  const response = await fetchImpl(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new OidcError({
      code: "token_request_failed",
      message: `The token request failed with ${response.status}.`,
      status: response.status,
      ...(typeof body.error === "string" ? { oauthError: body.error } : {}),
    });
  }
  if (typeof body.id_token !== "string") {
    throw new OidcError({
      code: "missing_id_token",
      message: "The token response has no id_token.",
    });
  }
  return {
    idToken: body.id_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
  };
}

const toTokens = (idToken: string, refreshToken: string | null): OidcTokens => {
  const claims = decodeIdTokenClaims(idToken);
  return { idToken, refreshToken, expiresAtEpochMs: claims.exp * 1000, claims };
};

export async function exchangeAuthorizationCode(input: {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
  /** The nonce sent with the authorization request; the ID token must echo it. */
  readonly nonce: string;
  readonly fetch?: FetchLike;
}): Promise<OidcTokens> {
  const response = await requestTokens(
    input.metadata,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    },
    input.fetch ?? fetch,
  );
  const tokens = toTokens(response.idToken, response.refreshToken);
  if (tokens.claims.nonce !== input.nonce) {
    throw new OidcError({
      code: "nonce_mismatch",
      message: "The ID token nonce does not match the request.",
    });
  }
  return tokens;
}

export async function refreshOidcTokens(input: {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly fetch?: FetchLike;
}): Promise<OidcTokens> {
  const response = await requestTokens(
    input.metadata,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId },
    input.fetch ?? fetch,
  );
  // Providers that do not rotate refresh tokens omit it; keep the one we have.
  return toTokens(response.idToken, response.refreshToken ?? input.refreshToken);
}

const isOidcError = Schema.is(OidcError);

/** True when a refresh failure means the session is over rather than temporarily unavailable. */
export const isPermanentRefreshFailure = (error: unknown): boolean =>
  isOidcError(error) &&
  error.code === "token_request_failed" &&
  (error.oauthError === "invalid_grant" ||
    (error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429));
