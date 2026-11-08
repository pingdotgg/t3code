import * as Layer from "effect/Layer";
import { readWriteClient, ReadWriteTunnel } from "./ReadWriteTunnel.ts";
import { makeTunnelClient } from "./TunnelBinding.ts";

/** Runtime layer for {@link ReadWriteTunnel}. */
export const ReadWriteTunnelBinding = Layer.effect(
  ReadWriteTunnel,
  makeTunnelClient(
    "Cloudflare.Tunnel.ReadWriteTunnel",
    ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
    readWriteClient,
  ),
);
