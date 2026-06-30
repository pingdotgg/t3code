import { describe, expect, it } from "vitest";
import { AuthAdministrativeScopes } from "@t3tools/contracts";

import { PAIRING_SCOPE_OPTIONS } from "./ConnectionsSettings";

// Drift guard: the pairing-link scope picker must offer exactly the scopes an
// administrator can delegate. If a new scope is added to the auth scope set
// (AuthAdministrativeScopes) but not surfaced here, it becomes invisible and
// unmanageable in the UI — which is how workflow:read / workflow:operate ended
// up missing, blocking workflow-board creation for freshly-paired clients.
describe("PAIRING_SCOPE_OPTIONS", () => {
  it("covers exactly the administrative (delegatable) scope set", () => {
    const pickerScopes = PAIRING_SCOPE_OPTIONS.map((option) => option.scope).sort();
    const adminScopes = [...AuthAdministrativeScopes].sort();
    expect(pickerScopes).toEqual(adminScopes);
  });

  it("has no duplicate scope entries", () => {
    const pickerScopes = PAIRING_SCOPE_OPTIONS.map((option) => option.scope);
    expect(new Set(pickerScopes).size).toBe(pickerScopes.length);
  });
});
