import * as Layer from "effect/Layer";
import { readClient, ReadTunnel } from "./ReadTunnel.ts";
import { makeLocalTunnelClient } from "./TunnelLocalBinding.ts";

/**
 * Local implementation of the {@link ReadTunnel} binding — reads Cloudflare
 * Tunnels over the cfd_tunnel HTTP API using the **current credentials**
 * instead of a native Worker binding (`ReadTunnelBinding`) or a scoped API
 * token. No `host.bind`, no minted token, no Worker host.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read
 * tunnels with the same `get`/`list`/`getToken`/`getConfiguration` client you'd
 * use inside a Worker.
 *
 * @example Read a tunnel's connector token from an Action
 * ```typescript
 * const Inspect = Alchemy.Action(
 *   "Inspect",
 *   Effect.gen(function* () {
 *     const tunnels = yield* Cloudflare.Tunnel.ReadTunnel();
 *     const tunnelId = yield* tunnel.tunnelId;
 *     return Effect.fn(function* () {
 *       const t = yield* tunnels.get(yield* tunnelId);
 *       return t.result?.name;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Tunnel.ReadTunnelLocal)),
 * );
 * ```
 */
export const ReadTunnelLocal = Layer.effect(
  ReadTunnel,
  makeLocalTunnelClient(readClient),
);
