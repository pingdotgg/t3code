import * as Schema from "effect/Schema";

import { EnvironmentId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalServerAdvertisementVersion = Schema.Literal(1);
export type LocalServerAdvertisementVersion = typeof LocalServerAdvertisementVersion.Type;

/**
 * Presence record published by a loopback-only `t3 serve` process so a desktop
 * client running as the same user can find it.
 *
 * This record deliberately carries NO credential. A client proves it is the
 * same local user by writing a nonce into the user-private runtime directory
 * and presenting it to `/api/auth/local-pair`; the server issues a pairing
 * credential in that response and never writes one to disk. Treat every field
 * here as public-to-this-user metadata, not a secret.
 */
export const LocalServerAdvertisement = Schema.Struct({
  version: LocalServerAdvertisementVersion,
  instanceId: TrimmedNonEmptyString,
  pid: PositiveInt,
  startedAt: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type LocalServerAdvertisement = typeof LocalServerAdvertisement.Type;

/**
 * Proof that the caller can create a file inside the server owner's private
 * runtime directory, which on a 0700 XDG_RUNTIME_DIR means the caller is the
 * same local user. `challengePath` must resolve inside the challenge directory
 * and be a 0600 regular file owned by the server's uid whose contents equal
 * `nonce`.
 */
export const LocalServerPairingChallenge = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  // Filesystem paths are opaque bytes represented as strings. Do not trim:
  // leading or trailing whitespace can be part of a legitimate filename.
  challengePath: Schema.String.check(Schema.isMinLength(1)),
  nonce: TrimmedNonEmptyString,
});
export type LocalServerPairingChallenge = typeof LocalServerPairingChallenge.Type;

export const LocalServerPairingResult = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
  pairingExpiresAt: TrimmedNonEmptyString,
});
export type LocalServerPairingResult = typeof LocalServerPairingResult.Type;
