import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { readClient, ReadTunnel } from "./ReadTunnel.ts";

/** Runtime layer for {@link ReadTunnel}. */
export const ReadTunnelBinding = Layer.effect(
  ReadTunnel,
  makeTunnelClient(
    "Cloudflare.Tunnel.ReadTunnel",
    ["Cloudflare Tunnel Read"],
    readClient,
  ),
);
