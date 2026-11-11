import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Path prefix on the gateway host that reverse-proxies a peer environment. */
export const LAN_GATEWAY_ROUTE_PREFIX = "/__t3_gateway";

/** Peer advertised to every client when the LAN gateway is on. */
export const LanGatewayPeerAdvertisement = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type LanGatewayPeerAdvertisement = typeof LanGatewayPeerAdvertisement.Type;

/** Admin list row, including the stored upstream for Settings. */
export const LanGatewayPeerSummary = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: TrimmedNonEmptyString,
});
export type LanGatewayPeerSummary = typeof LanGatewayPeerSummary.Type;

export const LanGatewayAddInput = Schema.Struct({
  /** Private, loopback, or Tailscale base URL of a peer environment. */
  url: TrimmedNonEmptyString,
  /** Fails with `environment_mismatch` when `url` answers as a different environment. */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
});
export type LanGatewayAddInput = typeof LanGatewayAddInput.Type;

export const LanGatewayRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type LanGatewayRemoveInput = typeof LanGatewayRemoveInput.Type;

export const LanGatewayRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type LanGatewayRemoveResult = typeof LanGatewayRemoveResult.Type;

export const LanGatewayListResult = Schema.Struct({
  peers: Schema.Array(LanGatewayPeerSummary),
});
export type LanGatewayListResult = typeof LanGatewayListResult.Type;

/** Why adding or managing a LAN gateway peer failed. */
export class LanGatewayError extends Schema.TaggedError<LanGatewayError>()("LanGatewayError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "environment_mismatch",
    "not_private",
    "self",
    "storage",
    "disabled",
  ]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
