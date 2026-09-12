import { relayStageSlug } from "../deploymentConfig.ts";

const CONNECTOR_PATH = "/.well-known/t3-relay/connect";
const ENDPOINT_KEY = /^[a-f0-9]{16}$/u;

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

export type RelayEdgeRoute =
  | { readonly kind: "connector"; readonly endpointKey: string }
  | { readonly kind: "public"; readonly endpointKey: string };

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

  const endpointKey = hostname.slice(0, -suffix.length);
  if (!ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }

  return {
    kind: input.pathname === CONNECTOR_PATH ? "connector" : "public",
    endpointKey,
  };
}

export function relayEdgeRouteSuffix(stage: string, managedEndpointBaseDomain: string): string {
  const label = stage === "prod" ? "t3r" : `t3r-${relayStageSlug(stage)}`;
  if (label.length > 46) {
    throw new RangeError("Relay stage is too long for a first-level edge endpoint hostname.");
  }
  return `${label}.${normalizeHostname(managedEndpointBaseDomain)}`;
}

export function relayEdgeEndpointHostname(
  stage: string,
  managedEndpointBaseDomain: string,
  environmentHash: string,
): string {
  const endpointKey = environmentHash.toLowerCase().slice(0, 16);
  if (!ENDPOINT_KEY.test(endpointKey)) {
    throw new TypeError(
      "Relay edge endpoint hash must contain at least 16 hexadecimal characters.",
    );
  }
  return `${endpointKey}-${relayEdgeRouteSuffix(stage, managedEndpointBaseDomain)}`;
}

export const relayConnectorPath = CONNECTOR_PATH;
