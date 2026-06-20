import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_TUNNEL_PREFIX = "t3coderelay-managedendpoint";
export const MANAGED_ENDPOINT_ZONE_OWNER_STAGE = "prod";

export class RelayPublicDomainLabelTooLongError extends Schema.TaggedErrorClass<RelayPublicDomainLabelTooLongError>()(
  "RelayPublicDomainLabelTooLongError",
  {
    stage: Schema.String,
    label: Schema.String,
    maxLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Relay stage '${this.stage}' produces custom domain label '${this.label}' (${this.label.length} characters), exceeding the DNS label limit of ${this.maxLength}.`;
  }
}

function normalizeZoneName(zoneName: string): string {
  return zoneName
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function isDnsName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 253 &&
    name
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= DNS_LABEL_MAX_LENGTH &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
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

export function relayOwnsManagedEndpointZone(stage: string): boolean {
  return stage === MANAGED_ENDPOINT_ZONE_OWNER_STAGE;
}

export function relayPublicDomainForStage(stage: string, zoneName: string): string {
  const stageSlug = relayStageSlug(stage);
  const relayLabel = stage === "prod" ? "relay" : `relay-${stageSlug}`;
  if (relayLabel.length > DNS_LABEL_MAX_LENGTH) {
    throw new RelayPublicDomainLabelTooLongError({
      stage,
      label: relayLabel,
      maxLength: DNS_LABEL_MAX_LENGTH,
    });
  }
  return `${relayLabel}.${normalizeZoneName(zoneName)}`;
}

export function managedEndpointDigestInput(
  stage: string,
  userId: string,
  environmentId: string,
): string {
  return `${stage}:${userId}:${environmentId}`;
}

export function managedEndpointHostname(stage: string, baseDomain: string, hash: string): string {
  const label = appendDnsSafeSuffix(relayStageSlug(stage), stableSuffix(hash));
  return `${label}.${normalizeZoneName(baseDomain)}`;
}

export function isManagedEndpointHostname(hostname: string, baseDomain: string): boolean {
  const normalizedHostname = normalizeZoneName(hostname);
  const normalizedBaseDomain = normalizeZoneName(baseDomain);
  return (
    hostname === normalizedHostname &&
    isDnsName(normalizedHostname) &&
    isDnsName(normalizedBaseDomain) &&
    normalizedHostname.endsWith(`.${normalizedBaseDomain}`)
  );
}

export function managedEndpointForHostname(hostname: string): RelayManagedEndpoint {
  return {
    httpBaseUrl: `https://${hostname}/`,
    wsBaseUrl: `wss://${hostname}/ws`,
    providerKind: "cloudflare_tunnel",
  };
}

export function managedEndpointTunnelName(stage: string, hash: string): string {
  return `${MANAGED_ENDPOINT_TUNNEL_PREFIX}-${relayStageSlug(stage)}-${stableSuffix(hash)}`;
}
