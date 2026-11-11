import * as Layer from "effect/Layer";
import { readClient, ReadTunnel } from "./ReadTunnel.ts";
import { makeTunnelClient } from "./TunnelBinding.ts";

/** Runtime layer for {@link ReadTunnel}. */
export const ReadTunnelBinding = Layer.effect(
  ReadTunnel,
  makeTunnelClient("Cloudflare.Tunnel.ReadTunnel", ["Cloudflare Tunnel Read"], readClient),
);
