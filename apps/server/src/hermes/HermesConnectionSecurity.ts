export const HERMES_REMOTE_PAIRING_TOKEN_ENV = "HERMES_REMOTE_PAIRING_TOKEN";
export const HERMES_REMOTE_TLS_CERT_SHA256_ENV = "HERMES_REMOTE_TLS_CERT_SHA256";

export type HermesEndpointScope = "loopback" | "remote";

export type HermesConnectionSecurityCode =
  | "invalid_endpoint"
  | "remote_disabled"
  | "remote_instance_disabled"
  | "remote_pairing_required"
  | "remote_trust_required"
  | "remote_credential_reuse"
  | "remote_verification_unsupported";

export type HermesConnectionSecurityAssessment =
  | {
      readonly status: "ready";
      readonly scope: "loopback";
      readonly endpoint: string;
      readonly diagnosticEndpoint: string;
      readonly authToken: string;
    }
  | {
      readonly status: "blocked" | "unsupported";
      readonly scope: HermesEndpointScope | undefined;
      readonly code: HermesConnectionSecurityCode;
      readonly diagnosticEndpoint: string;
      readonly message: string;
    };

export interface HermesConnectionSecurityInput {
  readonly endpoint: string;
  readonly gatewayToken: string | undefined;
  readonly remoteGloballyEnabled: boolean;
  readonly remoteInstanceEnabled: boolean;
  readonly remotePairingToken: string | undefined;
  readonly remoteTlsCertificateSha256: string | undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SHA256_FINGERPRINT = /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/iu;

export function sanitizeHermesEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "<invalid-endpoint>";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const key of new Set(parsed.searchParams.keys())) {
    parsed.searchParams.set(key, "<redacted>");
  }
  return parsed.toString();
}

export function hermesEndpointScope(endpoint: string): HermesEndpointScope | undefined {
  try {
    return LOOPBACK_HOSTS.has(new URL(endpoint).hostname) ? "loopback" : "remote";
  } catch {
    return undefined;
  }
}

export function isRemoteHermesEndpoint(endpoint: string): boolean {
  return hermesEndpointScope(endpoint) === "remote";
}

export function assessHermesConnectionSecurity(
  input: HermesConnectionSecurityInput,
): HermesConnectionSecurityAssessment {
  const diagnosticEndpoint = sanitizeHermesEndpoint(input.endpoint);
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return blocked(
      "invalid_endpoint",
      undefined,
      diagnosticEndpoint,
      "Hermes endpoint must be a valid WebSocket URL.",
    );
  }

  const scope: HermesEndpointScope = LOOPBACK_HOSTS.has(endpoint.hostname) ? "loopback" : "remote";
  const hasQueryCredential = [...endpoint.searchParams.keys()].some(
    (key) => key.toLowerCase() === "token",
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    hasQueryCredential ||
    (scope === "loopback" ? endpoint.protocol !== "ws:" : endpoint.protocol !== "wss:")
  ) {
    return blocked(
      "invalid_endpoint",
      scope,
      diagnosticEndpoint,
      scope === "loopback"
        ? "Loopback Hermes endpoints must use credential-free ws://."
        : "Remote Hermes endpoints must use credential-free wss://.",
    );
  }

  if (scope === "loopback") {
    const gatewayToken = input.gatewayToken?.trim();
    if (!gatewayToken) {
      return blocked(
        "invalid_endpoint",
        scope,
        diagnosticEndpoint,
        "Loopback Hermes requires a sensitive HERMES_GATEWAY_TOKEN.",
      );
    }
    return {
      status: "ready",
      scope,
      endpoint: endpoint.toString(),
      diagnosticEndpoint,
      authToken: gatewayToken,
    };
  }

  if (!input.remoteGloballyEnabled) {
    return blocked(
      "remote_disabled",
      scope,
      diagnosticEndpoint,
      "Remote Hermes is disabled by the independent server kill switch.",
    );
  }
  if (!input.remoteInstanceEnabled) {
    return blocked(
      "remote_instance_disabled",
      scope,
      diagnosticEndpoint,
      "This Hermes instance has not explicitly enabled remote access.",
    );
  }

  const pairingToken = input.remotePairingToken?.trim();
  if (!pairingToken) {
    return blocked(
      "remote_pairing_required",
      scope,
      diagnosticEndpoint,
      `Remote Hermes requires a dedicated sensitive ${HERMES_REMOTE_PAIRING_TOKEN_ENV}.`,
    );
  }
  if (pairingToken === input.gatewayToken?.trim()) {
    return blocked(
      "remote_credential_reuse",
      scope,
      diagnosticEndpoint,
      "Remote Hermes pairing material must be distinct from the local gateway credential.",
    );
  }

  const fingerprint = input.remoteTlsCertificateSha256?.trim();
  if (!fingerprint || !SHA256_FINGERPRINT.test(fingerprint)) {
    return blocked(
      "remote_trust_required",
      scope,
      diagnosticEndpoint,
      `Remote Hermes requires an explicit SHA-256 certificate fingerprint in ${HERMES_REMOTE_TLS_CERT_SHA256_ENV}.`,
    );
  }

  return {
    status: "unsupported",
    scope,
    code: "remote_verification_unsupported",
    diagnosticEndpoint,
    message:
      "Remote Hermes is configured but unsupported: the current gateway/WebSocket transport cannot prove scoped pairing or verify the configured TLS certificate fingerprint.",
  };
}

function blocked(
  code: HermesConnectionSecurityCode,
  scope: HermesEndpointScope | undefined,
  diagnosticEndpoint: string,
  message: string,
): HermesConnectionSecurityAssessment {
  return { status: "blocked", scope, code, diagnosticEndpoint, message };
}
