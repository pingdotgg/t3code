import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizeRequestUrl,
  connectAuthorizeRequestCode,
  connectLoopbackCancelUrl,
  connectLoopbackRedirectUri,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

describe("connectAuth", () => {
  it("round-trips state, challenge, and loopback port through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.t3.codes",
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://app.t3.codes");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("carries the CLI device label through the fragment", () => {
    const parsed = new URL(
      buildConnectAuthorizeRequestUrl({
        hostedAppUrl: "https://app.t3.codes",
        state: "state-1",
        challenge: "challenge-1",
        loopbackPort: 34338,
        device: "  maria-mbp \u00b7   zsh ",
      }),
    );

    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)?.device).toBe("maria-mbp \u00b7 zsh");
  });

  it("derives the same short code from the request state on both sides", () => {
    const code = connectAuthorizeRequestCode("q7mK9xV2pL4nR8sT6wYzAQ");

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(connectAuthorizeRequestCode("q7mK9xV2pL4nR8sT6wYzAQ")).toBe(code);
    expect(connectAuthorizeRequestCode("q7mK9xV2pL4nR8sT6wYzAR")).not.toBe(code);
  });

  it("cancels through the loopback callback with the OAuth access_denied error", () => {
    const url = new URL(
      connectLoopbackCancelUrl({ state: "state-1", challenge: "challenge-1", loopbackPort: 34338 }),
    );

    expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("rejects authorize requests missing state, challenge, or port", () => {
    expect(readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect"))).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#state=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#challenge=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#state=abc&challenge=abc")),
    ).toBeNull();
  });

  it("rejects authorize requests whose loopback port is corrupted", () => {
    for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
      const url = new URL(
        `https://app.t3.codes/connect#state=state-1&challenge=challenge-1&port=${encodeURIComponent(port)}`,
      );
      expect(readConnectAuthorizeRequest(url), port).toBeNull();
    }
  });
});
