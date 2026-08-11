import { describe, expect, it } from "vite-plus/test";

import { readAccessToken } from "./claudeUsageFetch.ts";

const NOW_MILLIS = Date.UTC(2026, 7, 9, 12, 0, 0);

const credentials = (claudeAiOauth: Record<string, unknown>): string =>
  JSON.stringify({ claudeAiOauth });

describe("readAccessToken", () => {
  it("reads the token out of the CLI's envelope", () => {
    expect(
      readAccessToken(
        credentials({ accessToken: "sk-live", expiresAt: NOW_MILLIS + 60_000 }),
        NOW_MILLIS,
      ),
    ).toBe("sk-live");
  });

  it("accepts an epoch-second expiry that is still in the future", () => {
    // Some CLI versions write seconds. Comparing those against a millisecond
    // clock dates every token to 1970, which reads as "logged out" forever.
    expect(
      readAccessToken(
        credentials({ accessToken: "sk-live", expiresAt: Math.floor(NOW_MILLIS / 1000) + 3600 }),
        NOW_MILLIS,
      ),
    ).toBe("sk-live");
  });

  it("rejects an expired token in either epoch flavour", () => {
    expect(
      readAccessToken(
        credentials({ accessToken: "sk-dead", expiresAt: NOW_MILLIS - 1 }),
        NOW_MILLIS,
      ),
    ).toBeNull();
    expect(
      readAccessToken(
        credentials({ accessToken: "sk-dead", expiresAt: Math.floor(NOW_MILLIS / 1000) - 3600 }),
        NOW_MILLIS,
      ),
    ).toBeNull();
  });

  it("assumes an absent or unreadable expiry is usable", () => {
    // The endpoint is the real authority; a 401 already degrades to blank
    // meters, so guessing "expired" here would hide a working token.
    expect(readAccessToken(credentials({ accessToken: "sk-live" }), NOW_MILLIS)).toBe("sk-live");
    expect(
      readAccessToken(credentials({ accessToken: "sk-live", expiresAt: "soon" }), NOW_MILLIS),
    ).toBe("sk-live");
  });

  it("returns null for a truncated or tokenless credentials file", () => {
    expect(readAccessToken("{ not json", NOW_MILLIS)).toBeNull();
    expect(readAccessToken("null", NOW_MILLIS)).toBeNull();
    expect(readAccessToken(credentials({ accessToken: "   " }), NOW_MILLIS)).toBeNull();
  });
});
