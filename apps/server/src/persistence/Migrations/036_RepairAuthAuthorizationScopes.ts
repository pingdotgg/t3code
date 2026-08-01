import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import AuthAuthorizationScopes from "./031_AuthAuthorizationScopes.ts";
import AuthPairingProofKeyThumbprint from "./032_AuthPairingProofKeyThumbprint.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  const hasScopedAuthTables =
    pairingLinkColumns.some((column) => column.name === "scopes") &&
    sessionColumns.some((column) => column.name === "scopes");

  if (!hasScopedAuthTables) {
    yield* AuthAuthorizationScopes;
    yield* AuthPairingProofKeyThumbprint;
  }
});
