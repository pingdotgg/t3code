import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildConnectCliClerkAuthorizeUrl, connectCliSignInRedirectUrl } from "./connectCliAuth";

const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

describe("connectCliAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a PKCE authorize URL that redirects to the CLI's loopback listener", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sends the sign-in redirect to the authorize endpoint, not back to /connect", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const connectUrl =
      "https://app.t3.codes/connect#state=state-1&challenge=challenge-1&port=34338";
    const redirectUrl = connectCliSignInRedirectUrl(
      { state: "state-1", challenge: "challenge-1", loopbackPort: 34338 },
      connectUrl,
    );

    expect(redirectUrl).not.toBe(connectUrl);
    expect(new URL(redirectUrl).pathname).toBe("/oauth/authorize");
  });
});
