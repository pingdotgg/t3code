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

type PeerList = Pick<TailscaleStatus, "unidentifiedPeers"> & {
  readonly peers: ReadonlyArray<{ readonly stableNodeId: string }>;
};

/**
 * Whether `after` lists a device `before` did not, so a scan of `before` never looked it up.
 * Peers with no ID are compared by node key and address, so one replacing another counts.
 */
export const peersJoined = (before: PeerList, after: PeerList): boolean => {
  const known = new Set(before.peers.map((peer) => peer.stableNodeId));
  if (after.peers.some((peer) => !known.has(peer.stableNodeId))) return true;
  // By node key and address, so neither a new node at an old address nor a moved one hides.
  const keyOf = (peer: TailscaleStatus["unidentifiedPeers"][number]) =>
    `${peer.key} ${peer.address ?? ""}`;
  const unidentified = new Map<string, number>();
  for (const peer of before.unidentifiedPeers) {
    unidentified.set(keyOf(peer), (unidentified.get(keyOf(peer)) ?? 0) + 1);
  }
  return after.unidentifiedPeers.some((peer) => {
    const left = unidentified.get(keyOf(peer)) ?? 0;
    unidentified.set(keyOf(peer), left - 1);
    return left === 0;
  });
};

/**
 * The peers this host's tailnet policy grants T3 Code, by name, and the peers
 * whois could not read. A box cannot read its policy without root, but whois
 * shows each peer's grants toward it. `onGrant` runs as each grant is confirmed.
 */
export const policyGrantedPeers = Effect.fn("tailnetGrants.policyGrantedPeers")(function* <E, R>(
  status: TailscaleStatus,
  whois: (address: string) => Effect.Effect<TailscaleWhois, E, R>,
  onGrant: Effect.Effect<void> = Effect.void,
) {
  const peers: ReadonlyArray<{
    readonly address: string | undefined;
    readonly name: string;
    readonly stableNodeId: string | null;
  }> = [
    ...status.peers.map((peer) => {
      const address = peer.tailnetIpv4Addresses[0] ?? peer.tailnetIpv6Addresses[0];
      return {
        address,
        name: peer.hostName ?? address ?? peer.stableNodeId,
        stableNodeId: peer.stableNodeId,
      };
    }),
    ...status.unidentifiedPeers.map(({ address }) => ({
      address: address ?? undefined,
      name: address ?? "a peer with no ID",
      stableNodeId: null,
    })),
  ];
  const results = yield* Effect.forEach(
    peers,
    ({ address, name, stableNodeId }) => {
      if (address === undefined) return Effect.succeed({ name, granted: null });
      return whois(address).pipe(
        Effect.map((node) => ({
          name,
          // An address that now names another node, as after an account switch, is unread.
          granted:
            stableNodeId !== null && node.stableNodeId !== stableNodeId
              ? null
              : (Object.hasOwn(node.capabilities, TAILNET_APP_CAPABILITY) as boolean | null),
        })),
        Effect.orElseSucceed(() => ({ name, granted: null })),
        Effect.tap(({ granted }) => (granted === true ? onGrant : Effect.void)),
      );
    },
    { concurrency: 8 },
  );
  return {
    granted: results.flatMap((peer) => (peer.granted === true ? [peer.name] : [])),
    unreadable: results.flatMap((peer) => (peer.granted === null ? [peer.name] : [])),
  };
});
