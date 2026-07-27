import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { readWriteClient, ReadWriteTunnel } from "./ReadWriteTunnel.ts";

/** Runtime layer for {@link ReadWriteTunnel}. */
export const ReadWriteTunnelBinding = Layer.effect(
  ReadWriteTunnel,
  makeTunnelClient(
    "Cloudflare.Tunnel.ReadWriteTunnel",
    ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
    readWriteClient,
  ),
);
