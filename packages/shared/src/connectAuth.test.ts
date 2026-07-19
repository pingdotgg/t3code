import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  encodeConnectAuthCode,
  parseConnectAuthCode,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

describe("connectAuth", () => {
  it("round-trips state and challenge through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.t3.codes",
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://app.t3.codes");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
  });

  it("rejects authorize requests missing state or challenge", () => {
    expect(readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect"))).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#state=abc")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#challenge=abc")),
    ).toBeNull();
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
