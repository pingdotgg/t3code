import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentScopes,
  AuthGrantScopes,
  AuthStandardClientScopes,
  expandLegacyScopes,
  sessionGrantsScope,
} from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    expect(Schema.decodeUnknownSync(AuthEnvironmentScopes)(["review:write"])).toEqual([
      "review:write",
    ]);
    expect(() => Schema.decodeUnknownSync(AuthGrantScopes)(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  it("expands a pre-split standard grant to the current standard set", () => {
    const expanded = expandLegacyScopes([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "relay:read",
    ]);
    for (const scope of AuthStandardClientScopes) expect(expanded).toContain(scope);
    expect(expanded).not.toContain("access:write");
    expect(expanded).not.toContain("relay:write");
  });

  it("returns the same array when nothing needs expanding", () => {
    const scopes = ["filesystem:read", "relay:read"] as const;
    expect(expandLegacyScopes(scopes)).toBe(scopes);
  });

  it.each([
    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});
