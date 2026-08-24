import * as Layer from "effect/Layer";
import { makeLocalTunnelClient } from "./TunnelLocalBinding.ts";
import { WriteTunnel, writeClient } from "./WriteTunnel.ts";

/**
 * Local implementation of the {@link WriteTunnel} binding — creates, updates,
 * and deletes Cloudflare Tunnels over the cfd_tunnel HTTP API using the
 * **current credentials** instead of a native Worker binding
 * (`WriteTunnelBinding`) or a scoped API token. No `host.bind`, no minted
 * token, no Worker host.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can mutate
 * tunnels with the same `create`/`update`/`delete`/`putConfiguration` client
 * you'd use inside a Worker.
 *
 * @example Provision a tunnel from an Action
 * ```typescript
 * const Provision = Alchemy.Action(
 *   "Provision",
 *   Effect.gen(function* () {
 *     const tunnels = yield* Cloudflare.Tunnel.WriteTunnel();
 *     return Effect.fn(function* () {
 *       const tunnel = yield* tunnels.create({ name: "on-demand-tunnel" });
 *       return tunnel.result?.id;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Tunnel.WriteTunnelLocal)),
 * );
 * ```
 */
export const WriteTunnelLocal = Layer.effect(
  WriteTunnel,
  makeLocalTunnelClient(writeClient),
);
