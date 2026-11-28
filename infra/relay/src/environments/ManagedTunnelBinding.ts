import * as Cloudflare from "@alchemy.run/cloudflare";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const makeClient = (auth: Cloudflare.Tunnel.TunnelAuth) => ({
  ...Cloudflare.Tunnel.readWriteClient(auth),
  /**
   * Rotates the tunnel secret so its connectors cannot reconnect, then drops the
   * ones still attached. Cloudflare refuses to delete a tunnel with live connectors.
   */
  disconnect: Effect.fn("Cloudflare.Tunnel.disconnect")(function* (
    tunnelId: string,
    tunnelSecret: string,
  ) {
    const accountId = yield* auth.accountId;
    yield* auth.authorize(zeroTrust.patchTunnelCloudflared({ accountId, tunnelId, tunnelSecret }));
    yield* auth.authorize(zeroTrust.deleteTunnelCloudflaredConnection({ accountId, tunnelId }));
  }),
});

export type ManagedTunnelClient = ReturnType<typeof makeClient>;

export interface ManagedTunnel extends Binding.Service<
  ManagedTunnel,
  "T3CodeRelay.ManagedTunnel",
  () => Effect.Effect<
    ManagedTunnelClient,
    never,
    Cloudflare.Worker | Cloudflare.CloudflareEnvironment
  >
> {}

/** Alchemy's read-write tunnel binding, plus `disconnect`, which it does not expose. */
export const ManagedTunnel = Binding.Service<ManagedTunnel>("T3CodeRelay.ManagedTunnel");

// Same token policy id and permissions as Alchemy's ReadWriteTunnelBinding, so the
// Worker's scoped token is unchanged.
export const ManagedTunnelBinding = Layer.effect(
  ManagedTunnel,
  Cloudflare.Tunnel.makeTunnelClient(
    "Cloudflare.Tunnel.ReadWriteTunnel",
    ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
    makeClient,
  ),
);
