import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

export type MobilePreviewLiveTarget =
  | {
      readonly kind: "available";
      readonly uri: string;
      readonly resolution: "direct" | "environment-private-network";
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "gateway-required" | "invalid-url" | "local-loopback";
      readonly detail: string;
    };

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

const isDesktopLocalPreviewHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  return (
    isLoopbackHost(host) ||
    isLocalLoopbackHost(normalized) ||
    normalized === "::" ||
    normalized.endsWith(".localhost")
  );
};

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized.endsWith(".local") || normalized.endsWith(".ts.net")) {
    return true;
  }
  if (!normalized.includes(".") && !normalized.includes(":") && normalized !== "localhost") {
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(normalized);
  }
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) {
    return false;
  }
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

const unavailable = (
  reason: Extract<MobilePreviewLiveTarget, { readonly kind: "unavailable" }>["reason"],
  detail: string,
): MobilePreviewLiveTarget => ({ kind: "unavailable", reason, detail });

/**
 * Resolve a desktop preview URL for a WebView running on a different device.
 *
 * Public URLs are already directly reachable. Android can rewrite a
 * desktop-local URL when the paired environment itself is reached over LAN,
 * Bonjour, or Tailscale. iPad uses the authenticated preview gateway so
 * loopback-only desktop servers remain reachable without exposing every
 * project port.
 */
export function resolveMobilePreviewLiveTarget(input: {
  readonly previewUrl: string;
  readonly environmentHttpBaseUrl: string | null;
  readonly environmentRelayManaged?: boolean;
  readonly platform?: "android" | "ios";
}): MobilePreviewLiveTarget {
  let preview: URL;
  try {
    preview = new URL(normalizePreviewUrl(input.previewUrl));
  } catch {
    return unavailable("invalid-url", "This browser tab does not have a valid web address.");
  }

  if (preview.protocol !== "http:" && preview.protocol !== "https:") {
    return unavailable("invalid-url", "Browser supports only HTTP and HTTPS addresses.");
  }

  if (!isDesktopLocalPreviewHost(preview.hostname)) {
    return { kind: "available", uri: preview.toString(), resolution: "direct" };
  }

  if (input.environmentRelayManaged) {
    return unavailable(
      "gateway-required",
      input.platform === "android"
        ? "T3 Connect Browser is currently available on iPad only because Android WebView cannot isolate the gateway session. Desktop snapshot review still works through T3 Connect."
        : "Browser needs the authenticated preview gateway.",
    );
  }

  if (
    normalizeHostname(preview.hostname).endsWith(".localhost") &&
    normalizeHostname(preview.hostname) !== "localhost"
  ) {
    return unavailable(
      "local-loopback",
      "This browser tab uses a desktop-local hostname that cannot be mapped safely to the iPad. Use the environment's LAN or Tailscale host in its address.",
    );
  }

  if (!input.environmentHttpBaseUrl) {
    return unavailable(
      "local-loopback",
      "This browser tab points at the desktop's localhost. Connect to that environment over LAN or Tailscale to open it.",
    );
  }

  let environment: URL;
  try {
    environment = new URL(input.environmentHttpBaseUrl);
  } catch {
    return unavailable(
      "local-loopback",
      "This browser tab points at the desktop's localhost, but the environment address is unavailable.",
    );
  }

  if (isLocalLoopbackHost(environment.hostname)) {
    return unavailable(
      "local-loopback",
      "The iPad cannot use the desktop's localhost address. Pair with the desktop's LAN or Tailscale address to open this preview live.",
    );
  }

  if (input.platform === "ios") {
    return unavailable(
      "gateway-required",
      "Browser will use the authenticated preview gateway for this desktop-local address.",
    );
  }

  if (!isPrivateNetworkHost(environment.hostname)) {
    return unavailable(
      "gateway-required",
      input.platform === "android"
        ? "T3 Connect Browser is currently available on iPad only because Android WebView cannot isolate the gateway session. Desktop snapshot review still works through T3 Connect."
        : "Browser needs the authenticated preview gateway.",
    );
  }

  const environmentHost = normalizeHostname(environment.hostname);
  preview.hostname = environmentHost.includes(":") ? `[${environmentHost}]` : environmentHost;
  return {
    kind: "available",
    uri: preview.toString(),
    resolution: "environment-private-network",
  };
}
