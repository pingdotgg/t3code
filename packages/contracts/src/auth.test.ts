import { describe, expect, it } from "@effect/vitest";

import { AuthAdministrativeScopes, AuthStandardClientScopes } from "./auth.ts";

describe("auth scope contracts", () => {
  it("pins the standard client scope list", () => {
    expect(AuthStandardClientScopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "workflow:read",
      "workflow:operate",
      "terminal:operate",
      "review:write",
      "relay:read",
    ]);
  });

  it("pins the administrative scope list", () => {
    expect(AuthAdministrativeScopes).toEqual([
      ...AuthStandardClientScopes,
      "access:read",
      "access:write",
      "relay:write",
    ]);
  });
});
