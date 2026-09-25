import type {
  GetTunnelCloudflaredConfigurationError,
  GetTunnelCloudflaredConfigurationResponse,
  GetTunnelCloudflaredError,
  GetTunnelCloudflaredResponse,
  GetTunnelCloudflaredTokenError,
  GetTunnelCloudflaredTokenResponse,
  ListTunnelCloudflaredsError,
  ListTunnelCloudflaredsRequest,
  ListTunnelCloudflaredsResponse,
} from "@distilled.cloud/cloudflare/zero-trust";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Worker } from "../Workers/Worker.ts";
import type { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { type TunnelAuth } from "./TunnelBinding.ts";

/**
 * Binding that lets a Worker read Cloudflare Tunnels at runtime.
 *
 * Creates a scoped {@link AccountApiToken} with only the `Cloudflare Tunnel
 * Read` permission and binds its outputs into the Worker (the token value as a
 * `secret_text` binding) so runtime code can authenticate.
 *
 * @remarks
 *
 * `ReadTunnel` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable — `yield* Cloudflare.Tunnel.ReadTunnel()`.
 *
 * ### Reading tunnels at runtime
 * **Example:** Bind the read client
 * Bind once in the Init phase; every method is available on the returned client.
 * ```typescript
 * const tunnels = yield* Cloudflare.Tunnel.ReadTunnel();
 * ```
 *
 * **Example:** List tunnels
 * ```typescript
 * const { result } = yield* tunnels.list({ isDeleted: false });
 * ```
 *
 * **Example:** Fetch a tunnel and its connector token
 * `getToken` returns the plaintext token used to run `cloudflared`.
 * ```typescript
 * const tunnel = yield* tunnels.get(tunnelId);
 * const token = yield* tunnels.getToken(tunnelId);
 * ```
 *
 * **Example:** Read the ingress configuration
 * ```typescript
 * const { config } = yield* tunnels.getConfiguration(tunnelId);
 * ```
 *
 * ### Runtime Layer
 * Provide {@link ReadTunnelBinding} in the Worker's runtime layer.
 * ```typescript
 * Effect.provide(Cloudflare.Tunnel.ReadTunnelBinding)
 * ```
 *
 * @binding
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 */
export interface ReadTunnel extends Binding.Service<
  ReadTunnel,
  "Cloudflare.Tunnel.ReadTunnel",
  () => Effect.Effect<ReadTunnelClient, never, Worker | CloudflareEnvironment>
> {}

export const ReadTunnel = Binding.Service<ReadTunnel>(
  "Cloudflare.Tunnel.ReadTunnel",
);

/** List-tunnels request, minus the account id (supplied by the binding). */
export type ListTunnelsRequest = Omit<
  ListTunnelCloudflaredsRequest,
  "accountId"
>;

/**
 * Read-only tunnel operations. Backed by the `Cloudflare Tunnel Read`
 * permission group.
 */
export interface ReadTunnelClient {
  /** Fetch a single tunnel by id. */
  get(
    tunnelId: string,
  ): Effect.Effect<
    GetTunnelCloudflaredResponse,
    GetTunnelCloudflaredError,
    RuntimeContext
  >;
  /** List tunnels in the account. */
  list(
    request?: ListTunnelsRequest,
  ): Effect.Effect<
    ListTunnelCloudflaredsResponse,
    ListTunnelCloudflaredsError,
    RuntimeContext
  >;
  /** Fetch the connector token used to run the tunnel. */
  getToken(
    tunnelId: string,
  ): Effect.Effect<
    GetTunnelCloudflaredTokenResponse,
    GetTunnelCloudflaredTokenError,
    RuntimeContext
  >;
  /** Read the remotely-managed configuration (ingress rules) for a tunnel. */
  getConfiguration(
    tunnelId: string,
  ): Effect.Effect<
    GetTunnelCloudflaredConfigurationResponse,
    GetTunnelCloudflaredConfigurationError,
    RuntimeContext
  >;
}

/** Build the read-only client over an injectable {@link TunnelAuth}. */
export const readClient = (auth: TunnelAuth): ReadTunnelClient => {
  const { authorize } = auth;
  return {
    get: Effect.fn("Cloudflare.Tunnel.get")(function* (tunnelId) {
      const accountId = yield* auth.accountId;
      return yield* authorize(
        zeroTrust.getTunnelCloudflared({ accountId, tunnelId }),
      );
    }),
    list: Effect.fn("Cloudflare.Tunnel.list")(function* (request) {
      const accountId = yield* auth.accountId;
      return yield* authorize(
        zeroTrust.listTunnelCloudflareds({ accountId, ...request }),
      );
    }),
    getToken: Effect.fn("Cloudflare.Tunnel.getToken")(function* (tunnelId) {
      const accountId = yield* auth.accountId;
      return yield* authorize(
        zeroTrust.getTunnelCloudflaredToken({ accountId, tunnelId }),
      );
    }),
    getConfiguration: Effect.fn("Cloudflare.Tunnel.getConfiguration")(
      function* (tunnelId) {
        const accountId = yield* auth.accountId;
        return yield* authorize(
          zeroTrust.getTunnelCloudflaredConfiguration({ accountId, tunnelId }),
        );
      },
    ),
  };
};
