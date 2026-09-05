import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { WriteTunnel, writeClient } from "./WriteTunnel.ts";

/** Runtime layer for {@link WriteTunnel}. */
export const WriteTunnelBinding = Layer.effect(
  WriteTunnel,
  makeTunnelClient(
    "Cloudflare.Tunnel.WriteTunnel",
    ["Cloudflare Tunnel Write"],
    writeClient,
  ),
);
