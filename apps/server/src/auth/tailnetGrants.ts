import {
  AuthGrantScope,
  type AuthEnvironmentScope,
  TAILNET_APP_CAPABILITY,
  TAILNET_GRANT_PRESETS,
} from "@t3tools/contracts";
import type { TailscaleStatus, TailscaleWhois } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isGrantScope = Schema.is(AuthGrantScope);
const isGrantValue = Schema.is(Schema.Struct({ scopes: Schema.Array(Schema.String) }));

/**
 * The scopes the device's T3 Code grants add up to, or null when the policy
 * grants it none. A grant that names no known scope gives none: unknown names
 * grant nothing, so a typo cannot widen access.
 */
export const tailnetGrantScopes = (
  capabilities: TailscaleWhois["capabilities"],
): ReadonlyArray<AuthEnvironmentScope> | null => {
  if (!Object.hasOwn(capabilities, TAILNET_APP_CAPABILITY)) return null;
  const scopes = new Set<AuthEnvironmentScope>();
  for (const grant of capabilities[TAILNET_APP_CAPABILITY] ?? []) {
    for (const name of isGrantValue(grant) ? grant.scopes : []) {
      for (const scope of TAILNET_GRANT_PRESETS.get(name) ?? (isGrantScope(name) ? [name] : [])) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
};

/**
 * The peers this host's tailnet policy grants T3 Code, by name, and the peers
 * whois could not read. A box cannot read its policy without root, but whois
 * shows each peer's grants toward it.
 */
export const policyGrantedPeers = Effect.fn("tailnetGrants.policyGrantedPeers")(function* <E, R>(
  status: TailscaleStatus,
  whois: (address: string) => Effect.Effect<TailscaleWhois, E, R>,
) {
  const peers = [
    ...status.peers.map((peer) => {
      const address = peer.tailnetIpv4Addresses[0] ?? peer.tailnetIpv6Addresses[0];
      return { address, name: peer.hostName ?? address ?? peer.stableNodeId };
    }),
    ...status.unidentifiedPeerAddresses.map((address) => ({
      address: address ?? undefined,
      name: address ?? "a peer with no ID",
    })),
  ];
  const results = yield* Effect.forEach(
    peers,
    ({ address, name }) => {
      if (address === undefined) return Effect.succeed({ name, granted: null });
      return whois(address).pipe(
        Effect.map((node) => ({
          name,
          granted: Object.hasOwn(node.capabilities, TAILNET_APP_CAPABILITY) as boolean | null,
        })),
        Effect.orElseSucceed(() => ({ name, granted: null })),
      );
    },
    { concurrency: 8 },
  );
  return {
    granted: results.flatMap((peer) => (peer.granted === true ? [peer.name] : [])),
    unreadable: results.flatMap((peer) => (peer.granted === null ? [peer.name] : [])),
  };
});
