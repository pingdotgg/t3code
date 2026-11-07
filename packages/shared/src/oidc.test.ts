import { describe, expect, it } from "vite-plus/test";

import {
  OidcError,
  base64UrlEncode,
  buildAuthorizeUrl,
  createPkcePair,
  decodeIdTokenClaims,
  discoverOidc,
  exchangeAuthorizationCode,
  isDesktopOidcCallbackUrl,
  isIdTokenFresh,
  isPermanentRefreshFailure,
  oidcAccountLabel,
  oidcDiscoveryUrl,
  refreshOidcTokens,
  type OidcMetadata,
} from "./oidc.ts";

const ISSUER = "https://sso.example.com/realms/t3";
const metadata: OidcMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
  tokenEndpoint: `${ISSUER}/protocol/openid-connect/token`,
  deviceAuthorizationEndpoint: null,
};

const encodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const idToken = (claims: Record<string, unknown>) =>
  `${encodeJson({ alg: "ES256" })}.${encodeJson({ sub: "alice", iss: ISSUER, exp: 2_000_000_000, ...claims })}.signature`;

const jsonResponse = (body: unknown, status = 200) => Response.json(body, { status });

describe("discoverOidc", () => {
  it("reads the endpoints and composes the URL without a double slash", async () => {
    const urls: Array<string> = [];
    const found = await discoverOidc(`${ISSUER}/`, async (url) => {
      urls.push(url);
      return jsonResponse({
        issuer: `${ISSUER}/`,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        device_authorization_endpoint: `${ISSUER}/device`,
      });
    });

    expect(urls).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
    expect(oidcDiscoveryUrl(ISSUER)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(found.deviceAuthorizationEndpoint).toBe(`${ISSUER}/device`);
  });

  it.each([
    ["an issuer that differs by a trailing slash", { issuer: `${ISSUER}/` }, "issuer_mismatch"],
    [
      "a plain HTTP token endpoint",
      { token_endpoint: "http://sso.example.com/token" },
      "insecure_endpoint",
    ],
    ["a missing token endpoint", { token_endpoint: undefined }, "discovery_failed"],
  ])("rejects %s", async (_name, override, code) => {
    const failure = await discoverOidc(ISSUER, async () =>
      jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        ...override,
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OidcError);
    expect((failure as OidcError).code).toBe(code);
  });
});

describe("PKCE and authorization URL", () => {
  it("derives the RFC 7636 appendix B challenge", async () => {
    const pair = await createPkcePair("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pair.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("builds an authorization-code request with S256 and a nonce", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: metadata.authorizationEndpoint,
        clientId: "t3-code",
        redirectUri: "https://app.example.com/oidc/callback",
        state: "state-1",
        nonce: "nonce-1",
        challenge: "challenge-1",
      }),
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "t3-code",
      redirect_uri: "https://app.example.com/oidc/callback",
      scope: "openid profile email offline_access",
      state: "state-1",
      nonce: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });
});

describe("token requests", () => {
  const exchange = (body: unknown, nonce = "nonce-1") =>
    exchangeAuthorizationCode({
      metadata,
      clientId: "t3-code",
      redirectUri: "https://app.example.com/oidc/callback",
      code: "code-1",
      verifier: "verifier-1",
      nonce,
      fetch: async () => jsonResponse(body),
    });

  it("exchanges a code for the ID token and its expiry", async () => {
    let sentBody = "";
    const tokens = await exchangeAuthorizationCode({
      metadata,
      clientId: "t3-code",
      redirectUri: "https://app.example.com/oidc/callback",
      code: "code-1",
      verifier: "verifier-1",
      nonce: "nonce-1",
      fetch: async (_url, init) => {
        sentBody = String(init?.body);
        return jsonResponse({
          id_token: idToken({ nonce: "nonce-1", email: "alice@example.com" }),
          refresh_token: "refresh-1",
        });
      },
    });

    expect(Object.fromEntries(new URLSearchParams(sentBody))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://app.example.com/oidc/callback",
      client_id: "t3-code",
      code_verifier: "verifier-1",
    });
    expect(tokens).toMatchObject({
      refreshToken: "refresh-1",
      expiresAtEpochMs: 2_000_000_000_000,
    });
    expect(oidcAccountLabel(tokens.claims)).toBe("alice@example.com");
  });

  it("rejects an ID token with another nonce or none at all", async () => {
    await expect(exchange({ id_token: idToken({ nonce: "other" }) })).rejects.toMatchObject({
      code: "nonce_mismatch",
    });
    await expect(exchange({ access_token: "opaque" })).rejects.toMatchObject({
      code: "missing_id_token",
    });
  });

  it("keeps the current refresh token when the provider does not rotate it", async () => {
    const tokens = await refreshOidcTokens({
      metadata,
      clientId: "t3-code",
      refreshToken: "refresh-1",
      fetch: async () => jsonResponse({ id_token: idToken({}) }),
    });
    expect(tokens.refreshToken).toBe("refresh-1");
  });

  it("tells a rejected refresh apart from a temporary failure", async () => {
    const rejected = await refreshOidcTokens({
      metadata,
      clientId: "t3-code",
      refreshToken: "refresh-1",
      fetch: async () => jsonResponse({ error: "invalid_grant" }, 400),
    }).catch((error: unknown) => error);
    const unavailable = await refreshOidcTokens({
      metadata,
      clientId: "t3-code",
      refreshToken: "refresh-1",
      fetch: async () => jsonResponse({}, 503),
    }).catch((error: unknown) => error);

    expect(isPermanentRefreshFailure(rejected)).toBe(true);
    expect(isPermanentRefreshFailure(unavailable)).toBe(false);
  });
});

describe("ID token helpers", () => {
  it("refuses a token without the required claims", () => {
    expect(() => decodeIdTokenClaims("not-a-jwt")).toThrow(OidcError);
    expect(() => decodeIdTokenClaims(`a.${encodeJson({ iss: ISSUER })}.c`)).toThrow(OidcError);
  });

  it("treats a token as fresh only with a minute to spare", () => {
    expect(isIdTokenFresh({ expiresAtEpochMs: 200_000 }, 100_000)).toBe(true);
    expect(isIdTokenFresh({ expiresAtEpochMs: 150_000 }, 100_000)).toBe(false);
  });
});

describe("isDesktopOidcCallbackUrl", () => {
  it.each([
    ["t3code://app/oidc/callback?code=c&state=s", true],
    ["t3code-dev://app/oidc/callback?code=c&state=s", true],
    ["t3code://app/settings?code=c", false],
    ["https://app/oidc/callback?code=c", false],
    ["t3code://evil/oidc/callback?code=c", false],
    ["not a url", false],
  ])("%s → %s", (value, expected) => {
    expect(isDesktopOidcCallbackUrl(value)).toBe(expected);
  });
});
