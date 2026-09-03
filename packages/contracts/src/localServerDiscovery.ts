import * as Schema from "effect/Schema";

import { EnvironmentId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalServerRuntimeVariant = Schema.Literals(["userdata", "dev"]);
export type LocalServerRuntimeVariant = typeof LocalServerRuntimeVariant.Type;

export const RunningLocalServer = Schema.Struct({
  statePath: Schema.String.check(Schema.isMinLength(1)),
  baseDir: Schema.String.check(Schema.isMinLength(1)),
  variant: LocalServerRuntimeVariant,
  pid: PositiveInt,
  httpBaseUrl: TrimmedNonEmptyString,
  startedAt: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type RunningLocalServer = typeof RunningLocalServer.Type;

export const LocalServerPairCommandOutput = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type LocalServerPairCommandOutput = typeof LocalServerPairCommandOutput.Type;

export const LocalServerPairingResult = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
  pairingExpiresAt: TrimmedNonEmptyString,
});
export type LocalServerPairingResult = typeof LocalServerPairingResult.Type;
