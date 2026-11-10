import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

const CHANNEL_PATH = /^\/env\/([0-9a-f]{32})(?=[/?]|$)(.*)$/su;

/**
 * Path key for an environment's relay channel. Environment ids are public, so the key also
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

/** Where clients reach an environment carried by this relay: `<relay>/env/<key>/`. */
export function channelEndpoint(relayOrigin: string, key: string): RelayManagedEndpoint {
  const origin = new URL(relayOrigin);
  const wsProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBaseUrl: `${origin.origin}/env/${key}/`,
    wsBaseUrl: `${wsProtocol}//${origin.host}/env/${key}/ws`,
    providerKind: "t3_relay",
  };
}

/** Splits a request URL under `/env/<key>` into its channel key, that prefix, and the environment path. */
export function channelPathTarget(
  url: string,
): { readonly key: string; readonly prefix: string; readonly path: string } | null {
  const match = CHANNEL_PATH.exec(url);
  if (match?.[1] === undefined) return null;
  const rest = match[2] ?? "";
  return {
    key: match[1],
    prefix: `/env/${match[1]}`,
    path: rest.startsWith("/") ? rest : `/${rest}`,
  };
}
