import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  connectLoopbackRedirectUri,
  encodeConnectAuthCode,
  parseConnectAuthCode,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

// The shapes the CLI prints: base64url over 16 random bytes and over a
// SHA-256 digest.
const STATE = "q7mK9xV2pL4nR8sT6wYzAQ";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("connectAuth", () => {
  it("round-trips state and challenge through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.t3.codes",
      state: STATE,
      challenge: CHALLENGE,
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://app.t3.codes");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      ok: true,
      request: { state: STATE, challenge: CHALLENGE },
    });
  });

  it("reports authorize requests missing state or challenge", () => {
    expect(readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect"))).toEqual({
      ok: false,
      problem: "missing",
    });
    expect(
      readConnectAuthorizeRequest(new URL(`https://app.t3.codes/connect#state=${STATE}`)),
    ).toEqual({ ok: false, problem: "missing" });
    expect(
      readConnectAuthorizeRequest(new URL(`https://app.t3.codes/connect#challenge=${CHALLENGE}`)),
    ).toEqual({ ok: false, problem: "missing" });
  });

  it("reports authorize requests whose values are not the shape the CLI prints", () => {
    const authorizeUrl = (state: string, challenge: string) =>
      new URL(
        buildConnectAuthorizeRequestUrl({
          hostedAppUrl: "https://app.t3.codes",
          state,
          challenge,
        }),
      );

    // A character the copied URL picked up from a wrapped terminal line.
    expect(
      readConnectAuthorizeRequest(
        authorizeUrl(`${STATE.slice(0, 10)}│${STATE.slice(11)}`, CHALLENGE),
      ),
    ).toEqual({
      ok: false,
      problem: "malformed",
    });
    expect(
      readConnectAuthorizeRequest(
        authorizeUrl(STATE, `${CHALLENGE.slice(0, 20)} ${CHALLENGE.slice(21)}`),
      ),
    ).toEqual({ ok: false, problem: "malformed" });
    // Truncated by a line break that was not copied along.
    expect(readConnectAuthorizeRequest(authorizeUrl(STATE.slice(0, 18), CHALLENGE))).toEqual({
      ok: false,
      problem: "malformed",
    });
    expect(readConnectAuthorizeRequest(authorizeUrl(STATE, CHALLENGE.slice(0, 30)))).toEqual({
      ok: false,
      problem: "malformed",
    });
    // Base64 padding and standard-alphabet characters are not base64url.
    expect(readConnectAuthorizeRequest(authorizeUrl(`${STATE.slice(0, 20)}==`, CHALLENGE))).toEqual(
      {
        ok: false,
        problem: "malformed",
      },
    );
    expect(readConnectAuthorizeRequest(authorizeUrl(STATE, `${CHALLENGE.slice(0, 42)}+`))).toEqual({
      ok: false,
      problem: "malformed",
    });
  });

  it("accepts values padded with whitespace while copying", () => {
    expect(
      readConnectAuthorizeRequest(
        new URL(`https://app.t3.codes/connect#state=+${STATE}+&challenge=${CHALLENGE}`),
      ),
    ).toEqual({ ok: true, request: { state: STATE, challenge: CHALLENGE } });
  });

  it("round-trips the loopback port through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.t3.codes",
      state: STATE,
      challenge: CHALLENGE,
      loopbackPort: 34338,
    });

    expect(readConnectAuthorizeRequest(new URL(url))).toEqual({
      ok: true,
      request: { state: STATE, challenge: CHALLENGE, loopbackPort: 34338 },
    });
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("rejects authorize requests whose loopback port is corrupted", () => {
    for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
      const url = new URL(
        `https://app.t3.codes/connect#state=${STATE}&challenge=${CHALLENGE}&port=${encodeURIComponent(port)}`,
      );
      expect(readConnectAuthorizeRequest(url), port).toEqual({
        ok: false,
        problem: "malformed",
      });
    }
  });

  it("builds a PKCE authorize URL against the Clerk endpoint", () => {
    const url = new URL(
      buildConnectClerkAuthorizeUrl({
        authorizationEndpoint: "https://clerk.t3.codes/oauth/authorize",
        clientId: "oauthapp_123",
        redirectUri: connectCallbackUrl("https://app.t3.codes"),
        scopes: ["openid", "profile", "email"],
        state: "state-1",
        challenge: "challenge-1",
      }),
    );

    expect(url.origin).toBe("https://clerk.t3.codes");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("oauthapp_123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.t3.codes/connect/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("round-trips the out-of-band authorization code and preserves dots inside it", () => {
    const blob = encodeConnectAuthCode({ code: "az9.code.chunk", state: "state-uuid" });
    expect(parseConnectAuthCode(blob)).toEqual({ code: "az9.code.chunk", state: "state-uuid" });
    expect(parseConnectAuthCode(`  ${blob}\n`)).toEqual({
      code: "az9.code.chunk",
      state: "state-uuid",
    });
  });

  it("rejects malformed out-of-band authorization codes", () => {
    expect(parseConnectAuthCode("")).toBeNull();
    expect(parseConnectAuthCode("no-separator")).toBeNull();
    expect(parseConnectAuthCode(".leading")).toBeNull();
    expect(parseConnectAuthCode("trailing.")).toBeNull();
  });
});
