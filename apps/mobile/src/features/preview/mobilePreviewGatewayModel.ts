export interface MobilePreviewGatewayTarget {
  readonly environmentHttpBaseUrl: string;
  readonly expiresAt: number;
  readonly serverEpoch: string | null;
  readonly sourceUrl: string;
  readonly tabId: string;
  readonly uri: string;
}

const INVALID_GATEWAY_ADDRESS = "The preview gateway returned an invalid bootstrap address.";
const GATEWAY_BOOTSTRAP_PREFIX = "/api/preview-gateway/bootstrap/";

export function mobilePreviewGatewayRequestKey(input: {
  readonly serverEpoch: string | null;
  readonly sourceUrl: string;
  readonly tabId: string;
}): string {
  return JSON.stringify([input.serverEpoch, input.tabId, input.sourceUrl]);
}

export function resolveMobilePreviewGatewayUri(input: {
  readonly environmentHttpBaseUrl: string;
  readonly relativeUrl: string;
}): string {
  if (
    !input.relativeUrl.startsWith(GATEWAY_BOOTSTRAP_PREFIX) ||
    input.relativeUrl.startsWith("//")
  ) {
    throw new Error(INVALID_GATEWAY_ADDRESS);
  }
  let environmentUrl: URL;
  let gatewayUrl: URL;
  try {
    environmentUrl = new URL(input.environmentHttpBaseUrl);
    gatewayUrl = new URL(input.relativeUrl, environmentUrl);
  } catch {
    throw new Error(INVALID_GATEWAY_ADDRESS);
  }
  if (
    (environmentUrl.protocol !== "http:" && environmentUrl.protocol !== "https:") ||
    gatewayUrl.origin !== environmentUrl.origin ||
    (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:")
  ) {
    throw new Error(INVALID_GATEWAY_ADDRESS);
  }
  return gatewayUrl.toString();
}

export function mobilePreviewGatewayTargetMatches(input: {
  readonly target: MobilePreviewGatewayTarget | null;
  readonly environmentHttpBaseUrl: string;
  readonly serverEpoch: string | null;
  readonly sourceUrl: string;
  readonly tabId: string;
}): boolean {
  return (
    input.target?.tabId === input.tabId &&
    input.target.environmentHttpBaseUrl === input.environmentHttpBaseUrl &&
    input.target.serverEpoch === input.serverEpoch &&
    input.target.sourceUrl === input.sourceUrl
  );
}
