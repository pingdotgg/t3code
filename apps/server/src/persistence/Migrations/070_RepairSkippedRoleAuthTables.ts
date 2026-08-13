import * as Effect from "effect/Effect";

import RepairRoleAuthTables from "./036_RepairRoleAuthTablesAfterScopeMigrations.ts";
import EnsureAuthSessionScopes from "./064_AuthSessionScopes.ts";
import EnsureAuthPairingLinkScopes from "./065_AuthPairingLinkScopes.ts";

export default Effect.gen(function* () {
  yield* RepairRoleAuthTables;
  yield* EnsureAuthSessionScopes;
  yield* EnsureAuthPairingLinkScopes;
});
