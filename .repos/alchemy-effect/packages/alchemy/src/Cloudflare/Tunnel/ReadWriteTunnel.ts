import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Worker } from "../Workers/Worker.ts";
import type { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { type TunnelAuth } from "./TunnelBinding.ts";
import { readClient, type ReadTunnelClient } from "./ReadTunnel.ts";
import { writeClient, type WriteTunnelClient } from "./WriteTunnel.ts";

/**
 * Binding that lets a Worker perform the full Cloudflare Tunnel CRUD surface at
 * runtime.
 *
 * Creates a scoped {@link AccountApiToken} with both the `Cloudflare Tunnel
 * Read` and `Cloudflare Tunnel Write` permissions and binds its outputs into
 * the Worker (the token value as a `secret_text` binding) so runtime code can
 * authenticate.
 *
 * @binding
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 *
 * `ReadWriteTunnel` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Tunnel.ReadWriteTunnel()`.
 *
 * @section Managing tunnels at runtime
 * @example Create, configure, and delete a tunnel from a request handler
 * ```typescript
 * // init
 * const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const tunnel = yield* tunnels.create({ name: "on-demand-tunnel" });
 *     yield* tunnels.putConfiguration(tunnel.id!, {
 *       ingress: [
 *         { hostname: "app.example.com", service: "http://localhost:3000" },
 *         { service: "http_status:404" },
 *       ],
 *     });
 *     const token = yield* tunnels.getToken(tunnel.id!);
 *     return HttpServerResponse.json({ id: tunnel.id, token });
 *   }),
 * };
 * ```
 *
 * @section Runtime Layer
 * Provide {@link ReadWriteTunnelBinding} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.Tunnel.ReadWriteTunnelBinding)
 * ```
 */
export interface ReadWriteTunnel extends Binding.Service<
  ReadWriteTunnel,
  "Cloudflare.Tunnel.ReadWriteTunnel",
  () => Effect.Effect<
    ReadWriteTunnelClient,
    never,
    Worker | CloudflareEnvironment
  >
> {}

export const ReadWriteTunnel = Binding.Service<ReadWriteTunnel>(
  "Cloudflare.Tunnel.ReadWriteTunnel",
);

/** Combined read + write tunnel operations. */
export interface ReadWriteTunnelClient
  extends ReadTunnelClient, WriteTunnelClient {}

/** Build the combined read + write client over an injectable {@link TunnelAuth}. */
export const readWriteClient = (auth: TunnelAuth): ReadWriteTunnelClient => ({
  ...readClient(auth),
  ...writeClient(auth),
});
