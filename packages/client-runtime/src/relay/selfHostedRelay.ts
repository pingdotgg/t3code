import { RelayServiceMetadata } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Where each app keeps the relay a user chose instead of the build's default T3 Connect. */
export const SELF_HOSTED_RELAY_STORAGE_KEY = "t3-connect-self-hosted-relay";

export const SelfHostedRelay = Schema.Struct({
  relayUrl: Schema.String,
  oidcIssuer: Schema.String,
  oidcClientId: Schema.String,
  managedTunnels: Schema.Boolean,
});
export type SelfHostedRelay = typeof SelfHostedRelay.Type;

const decodeStoredRelay = Schema.decodeUnknownOption(Schema.fromJsonString(SelfHostedRelay));
const decodeServiceMetadata = Schema.decodeUnknownOption(RelayServiceMetadata);

/** Null for anything but a relay this module stored, so a corrupt entry falls back to the default. */
export function parseStoredSelfHostedRelay(value: string | null): SelfHostedRelay | null {
  if (value === null) return null;
  const relay = Option.getOrNull(decodeStoredRelay(value));
  return relay !== null && normalizeSecureRelayUrl(relay.relayUrl) === relay.relayUrl
    ? relay
    : null;
}

export const encodeSelfHostedRelay = (relay: SelfHostedRelay): string => JSON.stringify(relay);

class SelfHostedRelayError extends Error {
  override readonly name = "SelfHostedRelayError";
}

/** Asks the relay at a user-entered address how to sign in, so the user only types the address. */
export async function discoverSelfHostedRelay(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SelfHostedRelay> {
  const trimmed = address.trim();
  const relayUrl = normalizeSecureRelayUrl(
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  if (relayUrl === null) {
    throw new SelfHostedRelayError(
      "Enter the relay's HTTPS address, for example https://relay.example.com.",
    );
  }
  const response = await fetchImpl(`${relayUrl}/.well-known/t3-relay`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (response === null) throw new SelfHostedRelayError(`Could not reach ${relayUrl}.`);
  const metadata = response.ok
    ? Option.getOrNull(decodeServiceMetadata(await response.json().catch(() => null)))
    : null;
  if (metadata === null) {
    throw new SelfHostedRelayError(
      `${relayUrl} did not answer as a T3 relay. Check the address, or update the relay.`,
    );
  }
  if (metadata.oidc === null) {
    throw new SelfHostedRelayError(
      `${relayUrl} signs in with Clerk. Configure OIDC on the relay to use it from here.`,
    );
  }
  return {
    relayUrl,
    oidcIssuer: metadata.oidc.issuer,
    oidcClientId: metadata.oidc.clientId,
    managedTunnels: metadata.managedTunnels,
  };
}
