import * as Layer from "effect/Layer";
import { readWriteClient, ReadWriteTunnel } from "./ReadWriteTunnel.ts";
import { makeLocalTunnelClient } from "./TunnelLocalBinding.ts";

/**
 * Local implementation of the {@link ReadWriteTunnel} binding — performs the
 * full cfd_tunnel CRUD surface over the HTTP API using the **current
 * credentials** instead of a native Worker binding (`ReadWriteTunnelBinding`)
 * or a scoped API token. No `host.bind`, no minted token, no Worker host.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can manage
 * tunnels with the same combined read + write client you'd use inside a Worker.
 *
 * @example Configure a deployed tunnel from an Action
 * ```typescript
 * const Configure = Alchemy.Action(
 *   "Configure",
 *   Effect.gen(function* () {
 *     const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
 *     const tunnelId = yield* tunnel.tunnelId;
 *     return Effect.fn(function* () {
 *       const id = yield* tunnelId;
 *       yield* tunnels.putConfiguration(id, {
 *         ingress: [
 *           { hostname: "app.example.com", service: "http://localhost:3000" },
 *           { service: "http_status:404" },
 *         ],
 *       });
 *       const { config } = yield* tunnels.getConfiguration(id);
 *       return config;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Tunnel.ReadWriteTunnelLocal)),
 * );
 * ```
 */
export const ReadWriteTunnelLocal = Layer.effect(
  ReadWriteTunnel,
  makeLocalTunnelClient(readWriteClient),
);
