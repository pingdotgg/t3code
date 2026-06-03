import type {
  CreateTunnelCloudflaredError,
  CreateTunnelCloudflaredRequest,
  CreateTunnelCloudflaredResponse,
  DeleteTunnelCloudflaredError,
  DeleteTunnelCloudflaredResponse,
  PatchTunnelCloudflaredError,
  PatchTunnelCloudflaredRequest,
  PatchTunnelCloudflaredResponse,
  PutTunnelCloudflaredConfigurationError,
  PutTunnelCloudflaredConfigurationRequest,
  PutTunnelCloudflaredConfigurationResponse,
} from "@distilled.cloud/cloudflare/zero-trust";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { Worker } from "../Workers/Worker.ts";
import {
  authorizeWith,
  makeTunnelClient,
  makeTunnelPolicyLive,
  type TunnelToken,
} from "./TunnelBinding.ts";

/** Create-tunnel request, minus the account id (supplied by the binding). */
export type CreateTunnelRequest = Omit<
  CreateTunnelCloudflaredRequest,
  "accountId"
>;

/** Update-tunnel request, minus the account id and tunnel id (positional). */
export type UpdateTunnelRequest = Omit<
  PatchTunnelCloudflaredRequest,
  "accountId" | "tunnelId"
>;

/** Tunnel configuration body, minus the account id and tunnel id (positional). */
export type TunnelConfiguration = NonNullable<
  PutTunnelCloudflaredConfigurationRequest["config"]
>;

/**
 * Mutating tunnel operations. Backed by the `Cloudflare Tunnel Write`
 * permission group.
 */
export interface TunnelWriteClient {
  /** Create a new tunnel. */
  create(
    request: CreateTunnelRequest,
  ): Effect.Effect<
    CreateTunnelCloudflaredResponse,
    CreateTunnelCloudflaredError,
    RuntimeContext
  >;
  /** Update a tunnel's mutable fields (name, secret). */
  update(
    tunnelId: string,
    request: UpdateTunnelRequest,
  ): Effect.Effect<
    PatchTunnelCloudflaredResponse,
    PatchTunnelCloudflaredError,
    RuntimeContext
  >;
  /** Delete a tunnel by id. */
  delete(
    tunnelId: string,
  ): Effect.Effect<
    DeleteTunnelCloudflaredResponse,
    DeleteTunnelCloudflaredError,
    RuntimeContext
  >;
  /** Replace the remotely-managed configuration (ingress rules) for a tunnel. */
  putConfiguration(
    tunnelId: string,
    config: TunnelConfiguration,
  ): Effect.Effect<
    PutTunnelCloudflaredConfigurationResponse,
    PutTunnelCloudflaredConfigurationError,
    RuntimeContext
  >;
}

/** Build the write client over a bound token. */
export const writeClient = (token: TunnelToken): TunnelWriteClient => {
  const authorize = authorizeWith(token);
  return {
    create: Effect.fn("Cloudflare.Tunnel.create")(function* (request) {
      const accountId = yield* token.accountId;
      return yield* authorize(
        zeroTrust.createTunnelCloudflared({ accountId, ...request }),
      );
    }),
    update: Effect.fn("Cloudflare.Tunnel.update")(
      function* (tunnelId, request) {
        const accountId = yield* token.accountId;
        return yield* authorize(
          zeroTrust.patchTunnelCloudflared({ accountId, tunnelId, ...request }),
        );
      },
    ),
    delete: Effect.fn("Cloudflare.Tunnel.delete")(function* (tunnelId) {
      const accountId = yield* token.accountId;
      return yield* authorize(
        zeroTrust.deleteTunnelCloudflared({ accountId, tunnelId }),
      );
    }),
    putConfiguration: Effect.fn("Cloudflare.Tunnel.putConfiguration")(
      function* (tunnelId, config) {
        const accountId = yield* token.accountId;
        return yield* authorize(
          zeroTrust.putTunnelCloudflaredConfiguration({
            accountId,
            tunnelId,
            config,
          }),
        );
      },
    ),
  };
};

/**
 * Binding that lets a Worker create, update, and delete Cloudflare Tunnels at
 * runtime.
 *
 * Creates a scoped {@link AccountApiToken} with only the `Cloudflare Tunnel
 * Write` permission and binds its outputs into the Worker (the token value as a
 * `secret_text` binding) so runtime code can authenticate.
 *
 * @binding
 *
 * @section Mutating tunnels at runtime
 * @example Bind the write client
 * Bind once in the Init phase; every method is available on the returned client.
 * ```typescript
 * const tunnels = yield* Cloudflare.TunnelWrite.bind();
 * ```
 *
 * @example Create a tunnel
 * ```typescript
 * const tunnel = yield* tunnels.create({ name: "on-demand-tunnel" });
 * ```
 *
 * @example Push ingress configuration
 * ```typescript
 * yield* tunnels.putConfiguration(tunnel.id!, {
 *   ingress: [
 *     { hostname: "app.example.com", service: "http://localhost:3000" },
 *     { service: "http_status:404" },
 *   ],
 * });
 * ```
 *
 * @example Rename and delete a tunnel
 * ```typescript
 * yield* tunnels.update(tunnel.id!, { name: "renamed-tunnel" });
 * yield* tunnels.delete(tunnel.id!);
 * ```
 *
 * @section Runtime Layer
 * Provide {@link TunnelWriteLive} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.TunnelWriteLive)
 * ```
 */
export class TunnelWrite extends Binding.Service<
  TunnelWrite,
  () => Effect.Effect<TunnelWriteClient, never, Worker>
>()("Cloudflare.TunnelWrite") {}

/**
 * Deploy-time policy for {@link TunnelWrite}. Attaches the `Cloudflare Tunnel
 * Write` permission to the token via its binding contract.
 */
export class TunnelWritePolicy extends Binding.Policy<
  TunnelWritePolicy,
  (token: AccountApiToken) => Effect.Effect<void>
>()("Cloudflare.TunnelWrite") {}

/** Runtime layer for {@link TunnelWrite}. */
export const TunnelWriteLive = Layer.effect(
  TunnelWrite,
  makeTunnelClient(TunnelWritePolicy, writeClient),
);

/** Live deploy-time policy layer for {@link TunnelWritePolicy}. */
export const TunnelWritePolicyLive = makeTunnelPolicyLive(
  TunnelWritePolicy,
  "Cloudflare.TunnelWrite",
  ["Cloudflare Tunnel Write"],
);
