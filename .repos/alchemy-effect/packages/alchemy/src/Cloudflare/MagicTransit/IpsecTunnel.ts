import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { MagicTunnelBgp, MagicTunnelHealthCheck } from "./GreTunnel.ts";

const TypeId = "Cloudflare.MagicTransit.IpsecTunnel" as const;
type TypeId = typeof TypeId;

export interface IpsecTunnelProps {
  /**
   * The name of the IPsec tunnel. Cannot share a name with other tunnels.
   * Immutable in practice — changing it triggers a replacement.
   */
  name: string;
  /**
   * The IP address assigned to the Cloudflare side of the IPsec tunnel
   * (a Cloudflare anycast IP allocated to the account).
   */
  cloudflareEndpoint: string;
  /**
   * The IP address assigned to the customer side of the IPsec tunnel. Not
   * required, but must be set for proactive traceroutes to work.
   */
  customerEndpoint?: string;
  /**
   * A 31-bit prefix (/31 in CIDR notation) from RFC1918 private space; one
   * host for each side of the tunnel.
   */
  interfaceAddress: string;
  /**
   * A /127 IPv6 prefix from within the account's `virtual_subnet6` space.
   */
  interfaceAddress6?: string;
  /**
   * An optional description of the IPsec tunnel.
   */
  description?: string;
  /**
   * Pre-shared key for the tunnel. Write-only — Cloudflare never returns
   * it, so the value is carried in state. When omitted, Cloudflare leaves
   * the tunnel without a PSK until one is generated via the dashboard/API.
   */
  psk?: Redacted.Redacted<string>;
  /**
   * If `true`, IPsec replay protection is supported in the
   * Cloudflare-to-customer direction.
   * @default false
   */
  replayProtection?: boolean;
  /**
   * Tunnel health-check configuration.
   */
  healthCheck?: MagicTunnelHealthCheck;
  /**
   * BGP configuration for the tunnel.
   */
  bgp?: MagicTunnelBgp;
  /**
   * Custom remote identities for IKE negotiation.
   */
  customRemoteIdentities?: {
    /** Identifier of the FQDN remote identity. */
    fqdnId?: string;
  };
  /**
   * True if automatic stateful return routing should be enabled. Requires
   * the `coupler_integration` account flag.
   * @default false
   */
  automaticReturnRouting?: boolean;
}

export interface IpsecTunnelAttributes {
  /** Cloudflare-assigned identifier of the IPsec tunnel. */
  tunnelId: string;
  /** The Cloudflare account the tunnel belongs to. */
  accountId: string;
  /** The name of the tunnel. */
  name: string;
  /** The IP address on the Cloudflare side of the tunnel. */
  cloudflareEndpoint: string;
  /** The IP address on the customer side of the tunnel, if set. */
  customerEndpoint: string | undefined;
  /** The /31 interface address of the tunnel. */
  interfaceAddress: string;
  /** The /127 IPv6 interface address, if configured. */
  interfaceAddress6: string | undefined;
  /** The tunnel description, if set. */
  description: string | undefined;
  /**
   * The pre-shared key as configured. Write-only on Cloudflare's side —
   * this is the value from props, carried in state, never read back.
   */
  psk: Redacted.Redacted<string> | undefined;
  /** Whether the tunnel allows a null cipher (`ENCR_NULL`) in Phase 2. */
  allowNullCipher: boolean | undefined;
  /** Whether replay protection is enabled. */
  replayProtection: boolean | undefined;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type IpsecTunnel = Resource<
  TypeId,
  IpsecTunnelProps,
  IpsecTunnelAttributes,
  never,
  Providers
>;

/**
 * A Magic Transit / Magic WAN IPsec tunnel between Cloudflare and a
 * customer device.
 *
 * Requires a Magic Transit or Magic WAN subscription on the account —
 * accounts that are not onboarded receive a typed
 * `MagicTransitNotOnboarded` error (Cloudflare code 1012).
 *
 * The tunnel `name` is unique per account and immutable in practice —
 * changing it triggers a replacement. The `psk` is write-only: Cloudflare
 * never returns it, so the configured value is carried in state.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating an IPsec tunnel
 * @example Basic tunnel with a provided PSK
 * ```typescript
 * const tunnel = yield* Cloudflare.MagicTransit.IpsecTunnel("branch", {
 *   name: "branch-ipsec-1",
 *   cloudflareEndpoint: "203.0.113.1",
 *   customerEndpoint: "198.51.100.1",
 *   interfaceAddress: "10.213.0.10/31",
 *   psk: alchemy.secret.env.IPSEC_PSK,
 * });
 * ```
 *
 * @example Tunnel with replay protection and health checks
 * ```typescript
 * const tunnel = yield* Cloudflare.MagicTransit.IpsecTunnel("branch", {
 *   name: "branch-ipsec-1",
 *   cloudflareEndpoint: "203.0.113.1",
 *   interfaceAddress: "10.213.0.10/31",
 *   replayProtection: true,
 *   healthCheck: { enabled: true, rate: "mid" },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/reference/tunnels/
 */
export const IpsecTunnel = Resource<IpsecTunnel>(TypeId);

/**
 * Returns true if the given value is an IpsecTunnel resource.
 */
export const isIpsecTunnel = (value: unknown): value is IpsecTunnel =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IpsecTunnelProvider = () =>
  Provider.succeed(IpsecTunnel, {
    stables: ["tunnelId", "accountId", "createdOn"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // The tunnel name is unique routing identity; renames are rejected.
      if (olds.name !== news.name) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.tunnelId) {
        const observed = yield* getTunnel(acct, output.tunnelId);
        // The PSK is write-only — carry the persisted value forward.
        if (observed) return toAttributes(observed, acct, output.psk);
      }
      // Cold read — tunnel names are unique per account. Tunnels carry no
      // ownership markers; report as Unowned so takeover is gated behind
      // the adopt policy.
      const name = output?.name ?? olds?.name;
      if (name) {
        const observed = yield* findByName(acct, name);
        if (observed) {
          return Unowned(toAttributes(observed, acct, output?.psk));
        }
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Observe — the id on `output` is a hint; fall through to the
      // unique-name lookup when it is gone.
      let observed = output?.tunnelId
        ? yield* getTunnel(accountId, output.tunnelId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, news.name);
      }

      const psk = news.psk ? Redacted.value(news.psk) : undefined;

      // Ensure — create when missing.
      if (!observed) {
        const created = yield* magicTransit.createIpsecTunnel({
          accountId,
          xMagicNewHcTarget: true,
          name: news.name,
          cloudflareEndpoint: news.cloudflareEndpoint,
          customerEndpoint: news.customerEndpoint,
          interfaceAddress: news.interfaceAddress,
          interfaceAddress6: news.interfaceAddress6,
          description: news.description,
          psk,
          replayProtection: news.replayProtection,
          automaticReturnRouting: news.automaticReturnRouting,
          customRemoteIdentities: news.customRemoteIdentities,
          bgp: toBgpRequest(news.bgp),
          healthCheck: toHealthCheckRequest(news.healthCheck),
        });
        return toAttributes(created, accountId, news.psk);
      }

      // Sync — diff observed cloud state against desired; the update API
      // is a full PUT, so send everything, but skip the call on a no-op.
      // The PSK cannot be observed: it is dirty when the desired value
      // differs from the last-applied props.
      const oldPsk = olds?.psk ? Redacted.value(olds.psk) : undefined;
      const pskDirty = psk !== undefined && psk !== oldPsk;
      if (dirty(observed, news) || pskDirty) {
        const updated = yield* magicTransit.updateIpsecTunnel({
          accountId,
          ipsecTunnelId: observed.id,
          xMagicNewHcTarget: true,
          name: news.name,
          cloudflareEndpoint: news.cloudflareEndpoint,
          customerEndpoint: news.customerEndpoint,
          interfaceAddress: news.interfaceAddress,
          interfaceAddress6: news.interfaceAddress6,
          description: news.description,
          psk: pskDirty ? psk : undefined,
          replayProtection: news.replayProtection,
          automaticReturnRouting: news.automaticReturnRouting,
          customRemoteIdentities: news.customRemoteIdentities,
          bgp: toBgpRequest(news.bgp),
          healthCheck: toHealthCheckRequest(news.healthCheck),
        });
        observed =
          updated.modifiedIpsecTunnel ??
          (yield* getTunnel(accountId, observed.id)) ??
          observed;
      }

      return toAttributes(observed, accountId, news.psk);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteIpsecTunnel({
          accountId: output.accountId,
          ipsecTunnelId: output.tunnelId,
          xMagicNewHcTarget: true,
        })
        .pipe(Effect.catchTag("IpsecTunnelNotFound", () => Effect.void));
    }),

    // Account-scoped collection. The list API returns the full tunnel set in
    // a single response (non-paginated). The PSK is write-only and never
    // returned, so it is `undefined` here — matching `read`'s cold-read shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* magicTransit
        .listIpsecTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(
          Effect.map((r) =>
            (r.ipsecTunnels ?? []).map((tunnel) =>
              toAttributes(tunnel, accountId, undefined),
            ),
          ),
          // Accounts that aren't onboarded onto Magic Transit (code 1012)
          // or lack the entitlement can't enumerate tunnels — treat as none.
          Effect.catchTag(
            ["MagicTransitNotOnboarded", "Forbidden"],
            (): Effect.Effect<IpsecTunnelAttributes[]> => Effect.succeed([]),
          ),
        );
    }),
  });

interface ObservedIpsecTunnel {
  id: string;
  name: string;
  cloudflareEndpoint: string;
  interfaceAddress: string;
  customerEndpoint?: string | null;
  interfaceAddress6?: string | null;
  description?: string | null;
  allowNullCipher?: boolean | null;
  replayProtection?: boolean | null;
  healthCheck?: {
    direction?: string | null;
    enabled?: boolean | null;
    rate?: string | null;
    target?:
      | { effective?: string | null; saved?: string | null }
      | string
      | null;
    type?: string | null;
  } | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}

/**
 * Read a tunnel by id, mapping "gone" (`IpsecTunnelNotFound`, Cloudflare
 * error code 1032) to `undefined`.
 */
const getTunnel = (accountId: string, ipsecTunnelId: string) =>
  magicTransit
    .getIpsecTunnel({ accountId, ipsecTunnelId, xMagicNewHcTarget: true })
    .pipe(
      Effect.map(
        (r): ObservedIpsecTunnel | undefined => r.ipsecTunnel ?? undefined,
      ),
      Effect.catchTag("IpsecTunnelNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a tunnel by exact name. Names are unique per account, so at most
 * one tunnel can match.
 */
const findByName = (accountId: string, name: string) =>
  magicTransit
    .listIpsecTunnels({ accountId, xMagicNewHcTarget: true })
    .pipe(
      Effect.map((r): ObservedIpsecTunnel | undefined =>
        (r.ipsecTunnels ?? []).find((t) => t.name === name),
      ),
    );

const toBgpRequest = (bgp: MagicTunnelBgp | undefined) =>
  bgp
    ? {
        customerAsn: bgp.customerAsn,
        extraPrefixes: bgp.extraPrefixes,
        md5Key: bgp.md5Key ? Redacted.value(bgp.md5Key) : undefined,
      }
    : undefined;

const toHealthCheckRequest = (hc: MagicTunnelHealthCheck | undefined) =>
  hc
    ? {
        enabled: hc.enabled,
        direction: hc.direction,
        rate: hc.rate,
        type: hc.type,
        target: hc.target ? { saved: hc.target } : undefined,
      }
    : undefined;

const observedHealthTarget = (
  healthCheck: ObservedIpsecTunnel["healthCheck"],
): string | undefined => {
  const target = healthCheck?.target;
  if (typeof target === "string") return target;
  return target?.saved ?? undefined;
};

const dirty = (
  observed: ObservedIpsecTunnel,
  news: IpsecTunnelProps,
): boolean =>
  observed.cloudflareEndpoint !== news.cloudflareEndpoint ||
  observed.interfaceAddress !== news.interfaceAddress ||
  (news.customerEndpoint !== undefined &&
    (observed.customerEndpoint ?? undefined) !== news.customerEndpoint) ||
  (news.interfaceAddress6 !== undefined &&
    (observed.interfaceAddress6 ?? undefined) !== news.interfaceAddress6) ||
  (news.description !== undefined &&
    (observed.description ?? undefined) !== news.description) ||
  (news.replayProtection !== undefined &&
    (observed.replayProtection ?? false) !== news.replayProtection) ||
  healthCheckDirty(observed.healthCheck, news.healthCheck);

const healthCheckDirty = (
  observed: ObservedIpsecTunnel["healthCheck"],
  desired: MagicTunnelHealthCheck | undefined,
): boolean => {
  if (desired === undefined) return false;
  const hc = observed ?? {};
  return (
    (desired.enabled !== undefined &&
      (hc.enabled ?? undefined) !== desired.enabled) ||
    (desired.direction !== undefined &&
      (hc.direction ?? undefined) !== desired.direction) ||
    (desired.rate !== undefined && (hc.rate ?? undefined) !== desired.rate) ||
    (desired.type !== undefined && (hc.type ?? undefined) !== desired.type) ||
    (desired.target !== undefined &&
      observedHealthTarget(hc) !== desired.target)
  );
};

const toAttributes = (
  tunnel: ObservedIpsecTunnel,
  accountId: string,
  psk: Redacted.Redacted<string> | undefined,
): IpsecTunnelAttributes => ({
  tunnelId: tunnel.id,
  accountId,
  name: tunnel.name,
  cloudflareEndpoint: tunnel.cloudflareEndpoint,
  customerEndpoint: tunnel.customerEndpoint ?? undefined,
  interfaceAddress: tunnel.interfaceAddress,
  interfaceAddress6: tunnel.interfaceAddress6 ?? undefined,
  description: tunnel.description ?? undefined,
  psk,
  allowNullCipher: tunnel.allowNullCipher ?? undefined,
  replayProtection: tunnel.replayProtection ?? undefined,
  createdOn: tunnel.createdOn ?? undefined,
  modifiedOn: tunnel.modifiedOn ?? undefined,
});
