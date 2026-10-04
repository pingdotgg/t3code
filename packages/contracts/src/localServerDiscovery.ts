import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Whether the desktop can pair with a discovered server by running its bundled
 * `t3 pair`. Pairing writes to the server's database, so it is only offered
 * when the server runs the same version as the desktop's bundled CLI.
 */
export const LocalServerPairingAvailability = Schema.Literals(["available", "version-mismatch"]);
export type LocalServerPairingAvailability = typeof LocalServerPairingAvailability.Type;

/** A T3 server running on this machine against the desktop's T3 home. */
export const RunningLocalServer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  pairing: LocalServerPairingAvailability,
});
export type RunningLocalServer = typeof RunningLocalServer.Type;

/** Stdout of `t3 pair --json`. */
export const LocalServerPairCommandOutput = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type LocalServerPairCommandOutput = typeof LocalServerPairCommandOutput.Type;

export const LocalServerPairingResult = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
});
export type LocalServerPairingResult = typeof LocalServerPairingResult.Type;
