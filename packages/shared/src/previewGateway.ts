export const PREVIEW_GATEWAY_HTTP_PATH = "/api/preview-gateway/http";
export const PREVIEW_GATEWAY_WEBSOCKET_PATH = "/api/preview-gateway/ws";
export const PREVIEW_GATEWAY_TICKET_HEADER = "x-t3-preview-gateway-ticket";
export const PREVIEW_GATEWAY_TARGET_HEADER = "x-t3-preview-gateway-target";

const normalizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/u, "");

export const isPreviewGatewayLoopbackHost = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1"
  ) {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  return (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    ipv4[0] === 127
  );
};

export const parsePreviewGatewayTarget = (
  rawUrl: string,
  protocols: ReadonlySet<string> = new Set(["http:", "ws:"]),
): URL | null => {
  try {
    const target = new URL(rawUrl);
    return protocols.has(target.protocol) && isPreviewGatewayLoopbackHost(target.hostname)
      ? target
      : null;
  } catch {
    return null;
  }
};

export const normalizePreviewGatewayDialTarget = (target: URL): URL => {
  const normalized = new URL(target);
  const hostname = normalizeHostname(normalized.hostname);
  if (
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    normalized.hostname = "localhost";
  }
  return normalized;
};
