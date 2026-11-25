/** Upstream T3 Code's own domain and its analytics vendors. PseudoCode refuses them at runtime. */
const BLOCKED_TELEMETRY_DOMAINS = ["t3.codes", "posthog.com", "axiom.co"] as const;

/** True for a blocked domain or any of its subdomains. */
export function isBlockedTelemetryHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/u, "");
  return BLOCKED_TELEMETRY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Electron `webRequest` URL filters covering every blocked domain over HTTP and WebSocket. */
export const BLOCKED_TELEMETRY_URL_PATTERNS: ReadonlyArray<string> =
  BLOCKED_TELEMETRY_DOMAINS.flatMap((domain) =>
    ["http", "https", "ws", "wss"].flatMap((scheme) => [
      `${scheme}://${domain}/*`,
      `${scheme}://*.${domain}/*`,
    ]),
  );
