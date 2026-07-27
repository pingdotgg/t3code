import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type TunnelProps = {
  /**
   * Name for the tunnel. If omitted, a unique name will be generated.
   *
   * Tunnel names are immutable -- changing the name triggers replacement.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Secret used by the tunnel connector. If omitted, Cloudflare generates one.
   * Must be at least 32 bytes encoded as base64.
   */
  tunnelSecret?: Redacted.Redacted<string>;
  /**
   * Where the tunnel configuration lives.
   * - `"cloudflare"` - managed remotely via the API (default)
   * - `"local"` - managed via a YAML file on the origin
   *
   * @default "cloudflare"
   */
  configSrc?: "cloudflare" | "local";
  /**
   * Ingress rules describing how requests are routed. Must end with a
   * catch-all rule (e.g. `{ service: "http_status:404" }`). Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  ingress?: Tunnel.IngressRule[];
  /**
   * Origin request configuration applied to all rules. Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  originRequest?: Tunnel.OriginRequestConfig;
  /**
   * Whether to adopt an existing tunnel with the same name when create fails.
   *
   * @default false
   */
  adopt?: boolean;
};

export declare namespace Tunnel {
  /**
   * Ingress rule describing how a hostname or path is routed.
   */
  export interface IngressRule {
    hostname?: string;
    service: string;
    path?: string;
    originRequest?: OriginRequestConfig;
  }
  /**
   * Origin request configuration applied per-rule or globally.
   */
  export interface OriginRequestConfig {
    connectTimeout?: number;
    tlsTimeout?: number;
    tcpKeepAlive?: number;
    noHappyEyeballs?: boolean;
    keepAliveConnections?: number;
    keepAliveTimeout?: number;
    http2Origin?: boolean;
    httpHostHeader?: string;
    caPool?: string;
    noTLSVerify?: boolean;
    disableChunkedEncoding?: boolean;
    proxyType?: string;
    matchSNItoHost?: boolean;
    originServerName?: string;
  }
}

export type Tunnel = Resource<
  "Cloudflare.Tunnel.Tunnel",
  TunnelProps,
  {
    tunnelId: string;
    tunnelName: string;
    accountTag: string | undefined;
    accountId: string;
    createdAt: string | undefined;
    deletedAt: string | undefined;
    configSrc: "cloudflare" | "local";
    token: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Tunnel that establishes a secure connection from your origin to
 * Cloudflare's edge.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Tunnel
 * @example Basic tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("MyTunnel");
 * // Run the connector with: cloudflared tunnel run --token <Redacted.value(tunnel.token)>
 * ```
 *
 * @example Tunnel with ingress rules
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("Web", {
 *   ingress: [
 *     { hostname: "app.example.com", service: "http://localhost:3000" },
 *     { service: "http_status:404" },
 *   ],
 * });
 * ```
 *
 * @section Managing Tunnels at Runtime
 * The `Tunnel` resource manages a single, statically-declared tunnel as part of
 * a stack. To create, read, update, or delete tunnels *on the fly* from inside
 * a deployed Worker, bind one of the runtime tunnel clients instead. Each
 * provisions a least-privilege {@link AccountApiToken} and injects it into the
 * Worker:
 *
 * - {@link ReadTunnel} — read-only (`get`, `list`, `getToken`,
 *   `getConfiguration`); scoped to `Cloudflare Tunnel Read`.
 * - {@link WriteTunnel} — mutating (`create`, `update`, `delete`,
 *   `putConfiguration`); scoped to `Cloudflare Tunnel Write`.
 * - {@link ReadWriteTunnel} — the full CRUD surface; scoped to both.
 *
 * @example Create a tunnel on demand from a Worker
 * ```typescript
 * // init
 * const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const tunnel = yield* tunnels.create({ name: "on-demand-tunnel" });
 *     const token = yield* tunnels.getToken(tunnel.id!);
 *     return HttpServerResponse.json({ id: tunnel.id, token });
 *   }),
 * };
 * ```
 */
export const Tunnel = Resource<Tunnel>("Cloudflare.Tunnel.Tunnel", {
  aliases: ["Cloudflare.Tunnel"],
});

export const TunnelProvider = () =>
  Provider.succeed(Tunnel, {
    stables: ["tunnelId", "accountTag", "accountId"],
    // Account collection: enumerate every cfd_tunnel in the account, skip
    // deleted tunnels (match `read`/`findTunnelByName`), exhaustively
    // paginate, then hydrate each into the exact `read` Attributes shape.
    // The token is fetched per-tunnel with bounded concurrency; a tunnel
    // whose token is gone is dropped (typed per-item not-found).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const tunnels = yield* zeroTrust.listTunnels
        .pages({ accountId, isDeleted: false, tunTypes: ["cfd_tunnel"] })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).filter(
                (t): t is typeof t & { id: string } => !!t.id && !t.deletedAt,
              ),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        tunnels,
        (t) =>
          zeroTrust
            .getTunnelCloudflaredToken({ accountId, tunnelId: t.id })
            .pipe(
              Effect.map((token): Tunnel["Attributes"] => ({
                tunnelId: t.id,
                tunnelName: t.name ?? t.id,
                accountTag: t.accountTag ?? undefined,
                accountId,
                createdAt: t.createdAt ?? undefined,
                deletedAt: t.deletedAt ?? undefined,
                configSrc: ((t as { configSrc?: "cloudflare" | "local" | null })
                  .configSrc ?? "cloudflare") as "cloudflare" | "local",
                token: Redacted.make(token),
              })),
              Effect.catchTag("TunnelTokenNotFound", () =>
                Effect.succeed(undefined),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is Tunnel["Attributes"] => row !== undefined,
      );
    }),
    diff: Effect.fn(function* ({ id, olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.tunnelName ?? (yield* createTunnelName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (name !== oldName) {
        return { action: "replace" } as const;
      }
      const oldSecret = olds.tunnelSecret
        ? Redacted.value(olds.tunnelSecret)
        : undefined;
      const newSecret = news.tunnelSecret
        ? Redacted.value(news.tunnelSecret)
        : undefined;
      if (oldSecret !== newSecret) {
        return { action: "replace" } as const;
      }
      if (
        (olds.configSrc ?? "cloudflare") !== (news.configSrc ?? "cloudflare")
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts.
      const name = yield* createTunnelName(id, news.name ?? output?.tunnelName);
      const configSrc = news.configSrc ?? output?.configSrc ?? "cloudflare";
      const tunnelSecret = news.tunnelSecret
        ? Redacted.value(news.tunnelSecret)
        : undefined;
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached tunnel; fall back to a name
      // lookup so we recover from out-of-band deletes or partial
      // state-persistence failures.
      let observed:
        | {
            id?: string | null;
            name?: string | null;
            accountTag?: string | null;
            createdAt?: string | null;
            deletedAt?: string | null;
          }
        | undefined;
      if (output?.tunnelId) {
        observed = yield* zeroTrust
          .getTunnelCloudflared({
            accountId: acct,
            tunnelId: output.tunnelId,
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
      if (!observed) {
        observed = yield* findTunnelByName(name);
      }

      // Ensure — create if missing. Cloudflare rejects a duplicate
      // name with a generic error; tolerate by adopting the
      // existing tunnel when the caller opted into adoption.
      if (!observed || !observed.id) {
        observed = yield* zeroTrust
          .createTunnelCloudflared({
            accountId: acct,
            name,
            configSrc,
            tunnelSecret,
          })
          .pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                if (!news.adopt) return yield* Effect.fail(err);
                const existing = yield* findTunnelByName(name);
                if (!existing || !existing.id) {
                  return yield* Effect.fail(err);
                }
                return existing;
              }),
            ),
          );
      }

      // Sync — when the tunnel is managed in Cloudflare, push the
      // desired ingress + originRequest configuration. The PUT is
      // idempotent: equal payloads converge to the same state, so we
      // always push to apply drift.
      if (configSrc !== "local") {
        yield* writeConfiguration(
          observed.id!,
          news.ingress,
          news.originRequest,
        );
      }

      const token = yield* zeroTrust.getTunnelCloudflaredToken({
        accountId: acct,
        tunnelId: observed.id!,
      });

      return {
        tunnelId: observed.id!,
        tunnelName: observed.name ?? name,
        accountTag: observed.accountTag ?? undefined,
        accountId: acct,
        createdAt: observed.createdAt ?? undefined,
        deletedAt: observed.deletedAt ?? undefined,
        configSrc,
        token: Redacted.make(token),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteTunnelCloudflared({
          accountId: output.accountId,
          tunnelId: output.tunnelId,
        })
        .pipe(Effect.catch(() => Effect.void));
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.tunnelId) {
        return yield* zeroTrust
          .getTunnelCloudflared({
            accountId: output.accountId,
            tunnelId: output.tunnelId,
          })
          .pipe(
            Effect.flatMap((t) =>
              zeroTrust
                .getTunnelCloudflaredToken({
                  accountId: output.accountId,
                  tunnelId: output.tunnelId,
                })
                .pipe(
                  Effect.map((token) => ({
                    tunnelId: t.id ?? output.tunnelId,
                    tunnelName: t.name ?? output.tunnelName,
                    accountTag: t.accountTag ?? output.accountTag,
                    accountId: output.accountId,
                    createdAt: t.createdAt ?? output.createdAt,
                    deletedAt: t.deletedAt ?? output.deletedAt,
                    configSrc: ((
                      t as { configSrc?: "cloudflare" | "local" | null }
                    ).configSrc ??
                      output.configSrc ??
                      "cloudflare") as "cloudflare" | "local",
                    token: Redacted.make(token),
                  })),
                ),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
      }
      const name = yield* createTunnelName(id, olds?.name);
      const existing = yield* findTunnelByName(name);
      if (!existing || !existing.id) return undefined;

      const token = yield* zeroTrust.getTunnelCloudflaredToken({
        accountId,
        tunnelId: existing.id,
      });
      return {
        tunnelId: existing.id,
        tunnelName: existing.name ?? name,
        accountTag: existing.accountTag ?? undefined,
        accountId,
        createdAt: existing.createdAt ?? undefined,
        deletedAt: existing.deletedAt ?? undefined,
        configSrc: ((existing as { configSrc?: "cloudflare" | "local" | null })
          .configSrc ?? "cloudflare") as "cloudflare" | "local",
        token: Redacted.make(token),
      };
    }),
  });

const createTunnelName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const writeConfiguration = (
  tunnelId: string,
  ingress: Tunnel.IngressRule[] | undefined,
  originRequest: Tunnel.OriginRequestConfig | undefined,
) =>
  Effect.gen(function* () {
    if (!ingress && !originRequest) return;
    const { accountId } = yield* yield* CloudflareEnvironment;
    yield* zeroTrust.putTunnelCloudflaredConfiguration({
      accountId,
      tunnelId,
      config: { ingress, originRequest },
    });
  });

const findTunnelByName = Effect.fn(function* (name: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* zeroTrust.listTunnels
    .items({
      accountId,
      name,
      isDeleted: false,
      tunTypes: ["cfd_tunnel"],
    })
    .pipe(
      Stream.filter((t) => t.name === name && !t.deletedAt),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );
});
