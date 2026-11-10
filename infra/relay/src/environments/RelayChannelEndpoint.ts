import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

const CHANNEL_KEY_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * Host label for an environment's relay channel. Environment ids are public, so the key also
 * covers the environment's public key: only the holder of a credential for that key can serve it.
 */
export const channelKey = (environmentId: string, environmentPublicKey: string) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`t3-relay-channel:${environmentId}:${environmentPublicKey.trim()}`),
    ),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

export function channelHostname(template: string, key: string): string {
  return template.toLowerCase().replace("*", key);
}

export function channelEndpoint(hostname: string): RelayManagedEndpoint {
  return {
    httpBaseUrl: `https://${hostname}/`,
    wsBaseUrl: `wss://${hostname}/ws`,
    providerKind: "t3_relay",
  };
}

/** The channel key a request's `Host` names under `template`, or null when it is not a channel host. */
export function channelKeyForHost(template: string, host: string): string | null {
  const [prefix = "", suffix] = template.toLowerCase().split("*");
  const hostname = host.toLowerCase().replace(/:\d+$/u, "");
  if (suffix === undefined || !hostname.startsWith(prefix) || !hostname.endsWith(suffix)) {
    return null;
  }
  const key = hostname.slice(prefix.length, hostname.length - suffix.length);
  return CHANNEL_KEY_PATTERN.test(key) ? key : null;
}
