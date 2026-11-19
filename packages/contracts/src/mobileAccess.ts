import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/** Recent phone connection attempts the host refused, so Settings can say why. */
export const MobileConnectionAttempt = Schema.Struct({
  at: IsoDateTime,
  surface: Schema.String,
  appVersion: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  clientProtocol: Schema.NullOr(Schema.Int),
  outcome: Schema.Literals(["protocol-mismatch", "credential-rejected"]),
  /** What the user should do, written for Settings. */
  explanation: Schema.String,
});
export type MobileConnectionAttempt = typeof MobileConnectionAttempt.Type;

export const MobileAccessStatus = Schema.Struct({
  serverProtocol: Schema.Int,
  /** The upstream T3 Code mobile releases this host was verified against. */
  verifiedClients: Schema.Array(Schema.String),
  attempts: Schema.Array(MobileConnectionAttempt),
});
export type MobileAccessStatus = typeof MobileAccessStatus.Type;
