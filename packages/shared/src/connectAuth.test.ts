import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizeRequestUrl,
  connectLoopbackRedirectUri,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

describe("connectAuth", () => {
  it("round-trips state, challenge, and loopback port through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://hyakki.ryoku.dev",
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://hyakki.ryoku.dev");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("rejects authorize requests missing state, challenge, or port", () => {
    expect(readConnectAuthorizeRequest(new URL("https://hyakki.ryoku.dev/connect"))).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://hyakki.ryoku.dev/connect#state=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(
        new URL("https://hyakki.ryoku.dev/connect#challenge=abc&port=34338"),
      ),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(
        new URL("https://hyakki.ryoku.dev/connect#state=abc&challenge=abc"),
      ),
    ).toBeNull();
  });

  it("rejects authorize requests whose loopback port is corrupted", () => {
    for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
      const url = new URL(
        `https://hyakki.ryoku.dev/connect#state=state-1&challenge=challenge-1&port=${encodeURIComponent(port)}`,
      );
      expect(readConnectAuthorizeRequest(url), port).toBeNull();
    }
  });
});
