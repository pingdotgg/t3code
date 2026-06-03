const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_HOST_PREFIX = "tunnels";
const MANAGED_ENDPOINT_TUNNEL_PREFIX = "t3coderelay-managedendpoint";

function normalizeZoneName(zoneName: string): string {
  return zoneName
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function stableSuffix(hash: string): string {
  return hash.toLowerCase().slice(0, MANAGED_ENDPOINT_HASH_LENGTH);
}

function appendDnsSafeSuffix(prefix: string, suffix: string): string {
  const truncatedPrefix = prefix
    .slice(0, DNS_LABEL_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/g, "");
  return `${truncatedPrefix}-${suffix}`;
}

/**
 * Alchemy's physical-name helper sanitizes resource names after adding the
 * stage. Keep custom domains and runtime-created resources aligned with it.
 */
export function relayStageSlug(stage: string): string {
  return stage
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function relayResourceNameForStage(name: string, stage: string): string {
  return `${name}-${relayStageSlug(stage)}`;
}

export function relayPublicDomainForStage(stage: string, zoneName: string): string {
  const stageSlug = relayStageSlug(stage);
  const relayLabel = stage === "prod" ? "relay" : `relay-${stageSlug}`;
  if (relayLabel.length > DNS_LABEL_MAX_LENGTH) {
    throw new Error(`Relay stage is too long for a custom domain: ${stage}`);
  }
  return `${relayLabel}.${normalizeZoneName(zoneName)}`;
}

export function managedEndpointDigestInput(stage: string, environmentId: string): string {
  return `${stage}:${environmentId}`;
}

export function managedEndpointHostname(stage: string, baseDomain: string, hash: string): string {
  const label = appendDnsSafeSuffix(
    `${MANAGED_ENDPOINT_HOST_PREFIX}-${relayStageSlug(stage)}`,
    stableSuffix(hash),
  );
  return `${label}.${normalizeZoneName(baseDomain)}`;
}

export function managedEndpointTunnelName(stage: string, hash: string): string {
  return `${MANAGED_ENDPOINT_TUNNEL_PREFIX}-${relayStageSlug(stage)}-${stableSuffix(hash)}`;
}
