import * as Effect from "effect/Effect";

import upstream032AuthPairingProofKeyThumbprint from "./032_AuthPairingProofKeyThumbprint.ts";
import upstream033ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";
import upstream034ProjectionThreadsSnoozed from "./034_ProjectionThreadsSnoozed.ts";

/**
 * Fork: legacy Forma databases (pre-merge dev state) kept their own migration
 * numbering past 31 — ids 32–34 were recorded for fork migrations
 * (`ProjectionProjectPreviewWorkspaceRecords`, `ResetProjectPreviewState`,
 * `EnsureProviderInstanceIdColumns`), so the migrator skipped upstream's
 * 032–034 (`AuthPairingProofKeyThumbprint`, `ProjectionThreadsSettled`,
 * `ProjectionThreadsSnoozed`) on those databases, leaving columns such as
 * `settled_override` missing. 938 only reconciles legacy ids 26–31.
 *
 * Upstream 032–034 are idempotent by construction (PRAGMA table_info guards),
 * so replaying them unconditionally is safe on every database shape: fresh
 * databases and correctly-migrated ones no-op, legacy-overlap databases gain
 * the missing columns. The stale history rows at 32–34 are intentionally left
 * in place — the migrator orders by id only, and rewriting history is riskier
 * than replaying idempotent effects.
 */
export default Effect.gen(function* () {
  yield* upstream032AuthPairingProofKeyThumbprint;
  yield* upstream033ProjectionThreadsSettled;
  yield* upstream034ProjectionThreadsSnoozed;
});
