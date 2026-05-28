import { describe, expect, it } from "vitest";

import {
  encodeOAuthScope,
  oauthScopeSetEquals,
  parseAllowedOAuthScope,
  parseOAuthScope,
} from "./oauthScope.ts";

describe("OAuth scope encoding", () => {
  it("parses scope as an order-independent set", () => {
    expect(parseOAuthScope("remote:session remote:connect remote:session")).toEqual([
      "remote:session",
      "remote:connect",
    ]);
    expect(
      oauthScopeSetEquals("remote:session remote:connect", ["remote:connect", "remote:session"]),
    ).toBe(true);
  });

  it("rejects invalid scope syntax and invalid outgoing scope sets", () => {
    expect(parseOAuthScope("remote:session\tremote:connect")).toBeNull();
    expect(parseOAuthScope("remote:session  remote:connect")).toBeNull();
    expect(() => encodeOAuthScope(["remote:session", "remote:session"])).toThrow();
  });

  it("applies a permitted-scope allowlist without imposing order", () => {
    const allowedScopes = new Set(["environment:connect", "environment:status"] as const);
    expect(
      parseAllowedOAuthScope({
        value: "environment:status environment:connect",
        allowedScopes,
      }),
    ).toEqual(["environment:status", "environment:connect"]);
    expect(
      parseAllowedOAuthScope({
        value: "mobile:registration",
        allowedScopes,
      }),
    ).toBeNull();
  });
});
