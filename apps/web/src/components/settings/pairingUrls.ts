import { isLoopbackHostname } from "../../environments/primary/target";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

/**
 * Whether an origin is one another device could actually open, and so worth
 * offering as a pairing URL instead of the pairing code.
 *
 * Loopback is the obvious no. The packaged desktop app is the non-obvious one:
 * it loads from a custom scheme (`t3code-dev://app/`), whose hostname is `app`,
 * which is not a loopback name — so testing only for loopback would call it
 * shareable and hand out a copy/QR link that resolves nowhere off this machine.
 */
export function isShareableOrigin(input: {
  readonly protocol: string;
  readonly hostname: string;
}): boolean {
  if (input.protocol !== "http:" && input.protocol !== "https:") {
    return false;
  }
  return !isLoopbackHostname(input.hostname);
}

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
