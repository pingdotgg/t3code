import * as Schema from "effect/Schema";

import { EnvironmentId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalServerAdvertisementVersion = Schema.Literal(1);
export type LocalServerAdvertisementVersion = typeof LocalServerAdvertisementVersion.Type;

/**
 * Private, short-lived handoff record published by a loopback-only `t3 serve`
 * process. The pairing URL contains a one-time credential; this is runtime
 * discovery state, never a steady-state credential store.
 */
export const LocalServerAdvertisement = Schema.Struct({
  version: LocalServerAdvertisementVersion,
  instanceId: TrimmedNonEmptyString,
  pid: PositiveInt,
  startedAt: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  pairingUrl: TrimmedNonEmptyString,
  pairingExpiresAt: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type LocalServerAdvertisement = typeof LocalServerAdvertisement.Type;
