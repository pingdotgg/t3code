/**
 * devPairing - Eligibility and request validation for dev-mode silent pairing.
 *
 * The dev pairing endpoint mints an administrative one-time credential with no
 * prior authentication, so eligibility is deliberately narrow: a web-mode dev
 * server, bound to loopback (policy "loopback-browser"), whose configured dev
 * URL is itself loopback. Request-level checks then require a browser-attached
 * Origin matching the dev origin exactly — the Origin header survives the Vite
 * dev proxy unmodified, which Host-based checks do not — plus a loopback Host
 * as anti-DNS-rebinding defense for direct requests.
 *
 * @module devPairing
 */
import type { ServerAuthDescriptor } from "@t3tools/contracts";

import type { ServerConfig } from "../config.ts";
import { isLoopbackHost, isLoopbackHostHeader, normalizeHost } from "../netHost.ts";

export interface DevPairingConfigInput {
  readonly mode: ServerConfig["Service"]["mode"];
  readonly devUrl: URL | undefined;
}

export const isDevPairingEligible = (
  config: DevPairingConfigInput,
  descriptor: ServerAuthDescriptor,
): boolean =>
  config.mode === "web" &&
  config.devUrl !== undefined &&
  isLoopbackHost(normalizeHost(config.devUrl.hostname)) &&
  descriptor.policy === "loopback-browser";

export type DevPairingRequestRejection = "origin_mismatch" | "host_not_loopback";

export const validateDevPairingRequestHeaders = (input: {
  readonly originHeader: string | undefined;
  readonly hostHeader: string | undefined;
  readonly devUrl: URL;
}): DevPairingRequestRejection | null => {
  if (!input.originHeader || input.originHeader.trim() !== input.devUrl.origin) {
    return "origin_mismatch";
  }
  if (!isLoopbackHostHeader(input.hostHeader)) {
    return "host_not_loopback";
  }
  return null;
};
