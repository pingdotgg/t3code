import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  encodeOAuthScope,
  OAuthScopeEncodingError,
  parseAllowedOAuthScope,
  parseOAuthScope,
} from "./oauthScope.ts";

const isOAuthScopeEncodingError = Schema.is(OAuthScopeEncodingError);

describe("OAuth scopes", () => {
  it("parses an RFC 6749 space-delimited scope set without duplicating permissions", () => {
    expect(parseOAuthScope("orchestration:read access:write orchestration:read")).toEqual([
      "orchestration:read",
      "access:write",
    ]);
  });

  it("rejects whitespace that is not the SP delimiter or introduces empty tokens", () => {
    expect(parseOAuthScope("orchestration:read\taccess:write")).toBeNull();
    expect(parseOAuthScope("orchestration:read  access:write")).toBeNull();
  });

  it("encodes and restricts requested scopes to the allowed capability set", () => {
    expect(encodeOAuthScope(["orchestration:read", "access:write"])).toBe(
      "orchestration:read access:write",
    );
    expect(
      parseAllowedOAuthScope({
        value: "orchestration:read access:write",
        allowedScopes: new Set(["orchestration:read", "access:write"] as const),
      }),
    ).toEqual(["orchestration:read", "access:write"]);
    expect(
      parseAllowedOAuthScope({
        value: "orchestration:read relay:write",
        allowedScopes: new Set(["orchestration:read", "access:write"] as const),
      }),
    ).toBeNull();
  });

  it("reports invalid encoding input structurally", () => {
    expect.assertions(5);

    try {
      encodeOAuthScope(["access:read", "invalid scope", "access:read"]);
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthScopeEncodingError);
      if (!isOAuthScopeEncodingError(error)) return;

      expect(error.scopes).toEqual(["access:read", "invalid scope", "access:read"]);
      expect(error.invalidScopes).toEqual(["invalid scope"]);
      expect(error.duplicateScopes).toEqual(["access:read"]);
      expect(error.message).toBe(
        "OAuth scopes must be non-empty, syntactically valid, and unique.",
      );
    }
  });
});
