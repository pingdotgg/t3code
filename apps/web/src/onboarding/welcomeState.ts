import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A computer's project choices on the Welcome page. They are stored until setup finishes, so a
 * visit to Settings or an app restart during setup keeps them.
 */
export const WelcomeImportSelection = Schema.Struct({
  // Projects listed when the selection changed; projects found later get the defaults.
  knownKeys: Schema.Array(Schema.String),
  keys: Schema.Array(Schema.String),
  // Unchecking the main box also leaves out projects found later, until it is checked again.
  optedOut: Schema.Boolean,
});
export type WelcomeImportSelection = typeof WelcomeImportSelection.Type;

export const StoredWelcomeImportSelection = Schema.NullOr(WelcomeImportSelection);

export const welcomeImportSelectionKey = (environmentId: EnvironmentId) =>
  `t3code:welcome-import-selection:${environmentId}`;
