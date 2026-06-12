import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { Worker } from "../Workers/Worker.ts";
import {
  makeTunnelClient,
  makeTunnelPolicyLive,
  type TunnelToken,
} from "./TunnelBinding.ts";
import { readClient, type TunnelReadClient } from "./TunnelRead.ts";
import { writeClient, type TunnelWriteClient } from "./TunnelWrite.ts";

/** Combined read + write tunnel operations. */
export interface TunnelReadWriteClient
  extends TunnelReadClient, TunnelWriteClient {}

/** Build the combined read + write client over a bound token. */
export const readWriteClient = (token: TunnelToken): TunnelReadWriteClient => ({
  ...readClient(token),
  ...writeClient(token),
});

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
 *
 * @section Managing tunnels at runtime
 * @example Create, configure, and delete a tunnel from a request handler
 * ```typescript
 * // init
 * const tunnels = yield* Cloudflare.TunnelReadWrite.bind();
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
 * Provide {@link TunnelReadWriteLive} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.TunnelReadWriteLive)
 * ```
 */
export class TunnelReadWrite extends Binding.Service<
  TunnelReadWrite,
  () => Effect.Effect<TunnelReadWriteClient, never, Worker>
>()("Cloudflare.TunnelReadWrite") {}

/**
 * Deploy-time policy for {@link TunnelReadWrite}. Attaches both the `Cloudflare
 * Tunnel Read` and `Cloudflare Tunnel Write` permissions to the token via its
 * binding contract.
 */
export class TunnelReadWritePolicy extends Binding.Policy<
  TunnelReadWritePolicy,
  (token: AccountApiToken) => Effect.Effect<void>
>()("Cloudflare.TunnelReadWrite") {}

/** Runtime layer for {@link TunnelReadWrite}. */
export const TunnelReadWriteLive = Layer.effect(
  TunnelReadWrite,
  makeTunnelClient(TunnelReadWritePolicy, readWriteClient),
);

/** Live deploy-time policy layer for {@link TunnelReadWritePolicy}. */
export const TunnelReadWritePolicyLive = makeTunnelPolicyLive(
  TunnelReadWritePolicy,
  "Cloudflare.TunnelReadWrite",
  ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
);
