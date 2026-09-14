import { relayStageSlug } from "../deploymentConfig.ts";

const CONNECTOR_PATH = "/.well-known/t3-relay/connect";
const ROUTE_KEY = /^[a-f0-9]{16}$/u;
const ROUTE_KEY_LENGTH = 16;
// A hostname label holds `<endpointKey>-<userKey>-<stageLabel>` and must stay
// within the 63 character DNS label limit.
const MAX_STAGE_LABEL_LENGTH = 63 - 2 * (ROUTE_KEY_LENGTH + 1);

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

/**
 * Where a relay endpoint lives. `userKey` selects the Durable Object that
 * holds every endpoint of one user; `endpointKey` selects the environment
 * inside that object. Both are opaque, stage-scoped hash prefixes.
 */
export interface RelayEndpointAddress {
  readonly userKey: string;
  readonly endpointKey: string;
}

export function isRelayRouteKey(value: string): boolean {
  return ROUTE_KEY.test(value);
}

export type RelayEdgeRoute =
  | ({ readonly kind: "connector" } & RelayEndpointAddress)
  | ({ readonly kind: "public" } & RelayEndpointAddress);

export function resolveRelayEdgeRoute(input: {
  readonly hostname: string;
  readonly pathname: string;
  readonly edgeRouteSuffix: string;
}): RelayEdgeRoute | null {
  const hostname = normalizeHostname(input.hostname);
  const edgeRouteSuffix = normalizeHostname(input.edgeRouteSuffix);
  const suffix = `-${edgeRouteSuffix}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }

  const keys = hostname.slice(0, -suffix.length).split("-");
  if (keys.length !== 2) {
    return null;
  }
  const [endpointKey, userKey] = keys as [string, string];
  if (!ROUTE_KEY.test(endpointKey) || !ROUTE_KEY.test(userKey)) {
    return null;
  }

  return {
    kind: input.pathname === CONNECTOR_PATH ? "connector" : "public",
    userKey,
    endpointKey,
  };
}

export function relayEdgeRouteSuffix(stage: string, managedEndpointBaseDomain: string): string {
  const label = stage === "prod" ? "t3r" : `t3r-${relayStageSlug(stage)}`;
  if (label.length > MAX_STAGE_LABEL_LENGTH) {
    throw new RangeError("Relay stage is too long for a first-level edge endpoint hostname.");
  }
  return `${label}.${normalizeHostname(managedEndpointBaseDomain)}`;
}

/** Truncates a hex digest to the opaque key length used in endpoint hostnames. */
export function relayRouteKey(hash: string): string {
  const key = hash.toLowerCase().slice(0, ROUTE_KEY_LENGTH);
  if (!ROUTE_KEY.test(key)) {
    throw new TypeError("Relay route keys need at least 16 hexadecimal characters.");
  }
  return key;
}

export function relayEdgeEndpointHostname(
  stage: string,
  managedEndpointBaseDomain: string,
  address: RelayEndpointAddress,
): string {
  const endpointKey = relayRouteKey(address.endpointKey);
  const userKey = relayRouteKey(address.userKey);
  return `${endpointKey}-${userKey}-${relayEdgeRouteSuffix(stage, managedEndpointBaseDomain)}`;
}

/**
 * Digest input for the user key. Distinct from the environment digest so a
 * user key can never equal an endpoint key of the same user.
 */
export function relayUserDigestInput(stage: string, userId: string): string {
  return `t3r-user:${stage}:${userId}`;
}

/**
 * Name of the Durable Object that serves a user. With no shard count every
 * user gets their own object. With a shard count, users are spread over that
 * many objects by the leading bits of their key. Changing the count moves
 * every user to a different object, so it is a deployment constant that only
 * changes together with a full relink.
 */
export function relayObjectName(userKey: string, shardCount?: number): string {
  if (shardCount === undefined) {
    return `user:${userKey}`;
  }
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError("Relay object shard count must be a positive integer.");
  }
  const shard = Number.parseInt(userKey.slice(0, 8), 16) % shardCount;
  return `shard:${shardCount}:${shard}`;
}

export const relayConnectorPath = CONNECTOR_PATH;
