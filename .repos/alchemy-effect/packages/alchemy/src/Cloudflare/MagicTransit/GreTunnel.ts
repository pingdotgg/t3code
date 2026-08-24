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

const TypeId = "Cloudflare.MagicTransit.GreTunnel" as const;
type TypeId = typeof TypeId;

/**
 * Health-check configuration for a Magic Transit tunnel.
 */
export interface MagicTunnelHealthCheck {
  /**
   * Whether tunnel health checks are enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Direction of the health check: `unidirectional` (default for Magic
   * Transit) probes only Cloudflare-to-customer, `bidirectional` probes
   * both directions.
   */
  direction?: "unidirectional" | "bidirectional";
  /**
   * Rate at which health checks are sent.
   * @default "mid"
   */
  rate?: "low" | "mid" | "high";
  /**
   * Health-check type: `reply` (default) expects ICMP replies, `request`
   * sends ICMP requests only.
   */
  type?: "reply" | "request";
  /**
   * The customer IP the health check targets. Defaults to
   * `customer_gre_endpoint` when omitted.
   */
  target?: string;
}

/**
 * BGP configuration for a Magic Transit tunnel.
 */
export interface MagicTunnelBgp {
  /**
   * ASN used on the customer end of the BGP session.
   */
  customerAsn: number;
  /**
   * Prefixes advertised in addition to the account's Magic prefixes.
   */
  extraPrefixes?: string[];
  /**
   * MD5 key to use for session authentication. Write-only.
   */
  md5Key?: Redacted.Redacted<string>;
}

export interface GreTunnelProps {
  /**
   * The name of the tunnel. Cannot contain spaces or special characters,
   * must be 15 characters or less, and cannot share a name with another GRE
   * tunnel. Immutable in practice — changing it triggers a replacement.
   */
  name: string;
  /**
   * The IP address assigned to the Cloudflare side of the GRE tunnel (a
   * Cloudflare anycast IP allocated to the account).
   */
  cloudflareGreEndpoint: string;
  /**
   * The IP address assigned to the customer side of the GRE tunnel.
   */
  customerGreEndpoint: string;
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
   * An optional description of the GRE tunnel.
   */
  description?: string;
  /**
   * Time To Live (TTL) in number of hops of the GRE tunnel.
   * @default 64
   */
  ttl?: number;
  /**
   * Maximum Transmission Unit (MTU) in bytes for the GRE tunnel. Minimum
   * value is 576.
   * @default 1476
   */
  mtu?: number;
  /**
   * Tunnel health-check configuration.
   */
  healthCheck?: MagicTunnelHealthCheck;
  /**
   * BGP configuration. The update API cannot change BGP settings —
   * changing this triggers a replacement.
   */
  bgp?: MagicTunnelBgp;
  /**
   * True if automatic stateful return routing should be enabled. Requires
   * the `coupler_integration` account flag.
   * @default false
   */
  automaticReturnRouting?: boolean;
}

export interface GreTunnelAttributes {
  /** Cloudflare-assigned identifier of the GRE tunnel. */
  tunnelId: string;
  /** The Cloudflare account the tunnel belongs to. */
  accountId: string;
  /** The name of the tunnel. */
  name: string;
  /** The IP address on the Cloudflare side of the tunnel. */
  cloudflareGreEndpoint: string;
  /** The IP address on the customer side of the tunnel. */
  customerGreEndpoint: string;
  /** The /31 interface address of the tunnel. */
  interfaceAddress: string;
  /** The /127 IPv6 interface address, if configured. */
  interfaceAddress6: string | undefined;
  /** The tunnel description, if set. */
  description: string | undefined;
  /** Time To Live (TTL) in number of hops. */
  ttl: number | undefined;
  /** Maximum Transmission Unit (MTU) in bytes. */
  mtu: number | undefined;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type GreTunnel = Resource<
  TypeId,
  GreTunnelProps,
  GreTunnelAttributes,
  never,
  Providers
>;

/**
 * A Magic Transit / Magic WAN GRE tunnel between Cloudflare and a customer
 * router.
 *
 * Requires a Magic Transit or Magic WAN subscription on the account —
 * accounts that are not onboarded receive a typed
 * `MagicTransitNotOnboarded` error (Cloudflare code 1012).
 *
 * The tunnel `name` is its routing identity (unique, ≤15 chars) — changing
 * it triggers a replacement, as does changing `bgp` (the update API cannot
 * modify BGP settings). Everything else is updated in place via PUT.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating a GRE tunnel
 * @example Basic tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.MagicTransit.GreTunnel("office", {
 *   name: "office-gre-1",
 *   cloudflareGreEndpoint: "203.0.113.1",
 *   customerGreEndpoint: "198.51.100.1",
 *   interfaceAddress: "10.213.0.8/31",
 * });
 * ```
 *
 * @example Tunnel with health checks and MTU
 * ```typescript
 * const tunnel = yield* Cloudflare.MagicTransit.GreTunnel("office", {
 *   name: "office-gre-1",
 *   cloudflareGreEndpoint: "203.0.113.1",
 *   customerGreEndpoint: "198.51.100.1",
 *   interfaceAddress: "10.213.0.8/31",
 *   mtu: 1476,
 *   ttl: 64,
 *   healthCheck: { enabled: true, rate: "mid", type: "reply" },
 * });
 * ```
 *
 * @section Routing traffic over the tunnel
 * @example Static route via the tunnel interface
 * ```typescript
 * yield* Cloudflare.MagicTransit.MagicStaticRoute("office-route", {
 *   prefix: "10.100.0.0/24",
 *   nexthop: "10.213.0.9",
 *   priority: 100,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-transit/
 */
export const GreTunnel = Resource<GreTunnel>(TypeId);

/**
 * Returns true if the given value is a GreTunnel resource.
 */
export const isGreTunnel = (value: unknown): value is GreTunnel =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const GreTunnelProvider = () =>
  Provider.succeed(GreTunnel, {
    stables: ["tunnelId", "accountId", "createdOn"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // The tunnel name is its routing identity; renames are rejected.
      if (olds.name !== news.name) return { action: "replace" } as const;
      // The update API has no `bgp` field — BGP changes require recreate.
      if (!sameBgp(olds.bgp, news.bgp)) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.tunnelId) {
        const observed = yield* getTunnel(acct, output.tunnelId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — tunnel names are unique per account, so an exact name
      // match identifies the tunnel. Tunnels carry no ownership markers;
      // report as Unowned so takeover is gated behind the adopt policy.
      const name = output?.name ?? olds?.name;
      if (name) {
        const observed = yield* findByName(acct, name);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Observe — the id on `output` is a hint; fall through to the
      // unique-name lookup when it is gone.
      let observed = output?.tunnelId
        ? yield* getTunnel(accountId, output.tunnelId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, news.name);
      }

      // Ensure — create when missing.
      if (!observed) {
        const created = yield* magicTransit.createGreTunnel({
          accountId,
          xMagicNewHcTarget: true,
          name: news.name,
          cloudflareGreEndpoint: news.cloudflareGreEndpoint,
          customerGreEndpoint: news.customerGreEndpoint,
          interfaceAddress: news.interfaceAddress,
          interfaceAddress6: news.interfaceAddress6,
          description: news.description,
          ttl: news.ttl,
          mtu: news.mtu,
          automaticReturnRouting: news.automaticReturnRouting,
          bgp: news.bgp
            ? {
                customerAsn: news.bgp.customerAsn,
                extraPrefixes: news.bgp.extraPrefixes,
                md5Key: news.bgp.md5Key
                  ? Redacted.value(news.bgp.md5Key)
                  : undefined,
              }
            : undefined,
          healthCheck: news.healthCheck
            ? {
                enabled: news.healthCheck.enabled,
                target: news.healthCheck.target
                  ? { saved: news.healthCheck.target }
                  : undefined,
              }
            : undefined,
        });
        observed = created;
      }

      // Sync — diff observed cloud state against desired; the update API
      // is a full PUT, so send everything, but skip the call on a no-op.
      // This also converges health-check fields the create API does not
      // accept (direction/rate/type).
      if (dirty(observed, news)) {
        const updated = yield* magicTransit.updateGreTunnel({
          accountId,
          greTunnelId: observed.id,
          xMagicNewHcTarget: true,
          name: news.name,
          cloudflareGreEndpoint: news.cloudflareGreEndpoint,
          customerGreEndpoint: news.customerGreEndpoint,
          interfaceAddress: news.interfaceAddress,
          interfaceAddress6: news.interfaceAddress6,
          description: news.description,
          ttl: news.ttl,
          mtu: news.mtu,
          automaticReturnRouting: news.automaticReturnRouting,
          healthCheck: news.healthCheck
            ? {
                enabled: news.healthCheck.enabled,
                direction: news.healthCheck.direction,
                rate: news.healthCheck.rate,
                type: news.healthCheck.type,
                target: news.healthCheck.target
                  ? { saved: news.healthCheck.target }
                  : undefined,
              }
            : undefined,
        });
        if (updated.modifiedGreTunnel) {
          observed = updated.modifiedGreTunnel;
        } else {
          // Defensive: re-read when the PUT response omits the tunnel.
          observed = (yield* getTunnel(accountId, observed.id)) ?? observed;
        }
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteGreTunnel({
          accountId: output.accountId,
          greTunnelId: output.tunnelId,
          xMagicNewHcTarget: true,
        })
        .pipe(Effect.catchTag("GreTunnelNotFound", () => Effect.void));
    }),

    // Account-scoped collection. `listGreTunnels` returns the full set in one
    // (non-paginated) call, so there is nothing to paginate. Accounts without
    // a Magic Transit subscription reject with the typed
    // `MagicTransitNotOnboarded` tag (code 1012) — and, depending on token
    // scope, a typed `Forbidden` (403). Both mean the account cannot enumerate
    // Magic Transit, so treat them as non-listable → [].
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* magicTransit
        .listGreTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(
          Effect.map((r): GreTunnelAttributes[] =>
            (r.greTunnels ?? []).map((tunnel) =>
              toAttributes(tunnel, accountId),
            ),
          ),
          Effect.catchTag(["MagicTransitNotOnboarded", "Forbidden"], () =>
            Effect.succeed<GreTunnelAttributes[]>([]),
          ),
        );
    }),
  });

interface ObservedGreTunnel {
  id: string;
  name: string;
  cloudflareGreEndpoint: string;
  customerGreEndpoint: string;
  interfaceAddress: string;
  interfaceAddress6?: string | null;
  description?: string | null;
  ttl?: number | null;
  mtu?: number | null;
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
 * Read a tunnel by id, mapping "gone" (`GreTunnelNotFound`, Cloudflare
 * error code 1029) to `undefined`.
 */
const getTunnel = (accountId: string, greTunnelId: string) =>
  magicTransit
    .getGreTunnel({ accountId, greTunnelId, xMagicNewHcTarget: true })
    .pipe(
      Effect.map(
        (r): ObservedGreTunnel | undefined => r.greTunnel ?? undefined,
      ),
      Effect.catchTag("GreTunnelNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a tunnel by exact name. Names are unique per account, so at most
 * one tunnel can match.
 */
const findByName = (accountId: string, name: string) =>
  magicTransit
    .listGreTunnels({ accountId, xMagicNewHcTarget: true })
    .pipe(
      Effect.map((r): ObservedGreTunnel | undefined =>
        (r.greTunnels ?? []).find((t) => t.name === name),
      ),
    );

const observedHealthTarget = (
  healthCheck: ObservedGreTunnel["healthCheck"],
): string | undefined => {
  const target = healthCheck?.target;
  if (typeof target === "string") return target;
  return target?.saved ?? undefined;
};

const dirty = (observed: ObservedGreTunnel, news: GreTunnelProps): boolean =>
  observed.cloudflareGreEndpoint !== news.cloudflareGreEndpoint ||
  observed.customerGreEndpoint !== news.customerGreEndpoint ||
  observed.interfaceAddress !== news.interfaceAddress ||
  (news.interfaceAddress6 !== undefined &&
    (observed.interfaceAddress6 ?? undefined) !== news.interfaceAddress6) ||
  (news.description !== undefined &&
    (observed.description ?? undefined) !== news.description) ||
  (news.ttl !== undefined && (observed.ttl ?? undefined) !== news.ttl) ||
  (news.mtu !== undefined && (observed.mtu ?? undefined) !== news.mtu) ||
  healthCheckDirty(observed, news.healthCheck);

const healthCheckDirty = (
  observed: ObservedGreTunnel,
  desired: MagicTunnelHealthCheck | undefined,
): boolean => {
  if (desired === undefined) return false;
  const hc = observed.healthCheck ?? {};
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

const sameBgp = (
  a: MagicTunnelBgp | undefined,
  b: MagicTunnelBgp | undefined,
): boolean => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  const aKey = a.md5Key ? Redacted.value(a.md5Key) : undefined;
  const bKey = b.md5Key ? Redacted.value(b.md5Key) : undefined;
  return (
    a.customerAsn === b.customerAsn &&
    aKey === bKey &&
    (a.extraPrefixes ?? []).join(",") === (b.extraPrefixes ?? []).join(",")
  );
};

const toAttributes = (
  tunnel: ObservedGreTunnel,
  accountId: string,
): GreTunnelAttributes => ({
  tunnelId: tunnel.id,
  accountId,
  name: tunnel.name,
  cloudflareGreEndpoint: tunnel.cloudflareGreEndpoint,
  customerGreEndpoint: tunnel.customerGreEndpoint,
  interfaceAddress: tunnel.interfaceAddress,
  interfaceAddress6: tunnel.interfaceAddress6 ?? undefined,
  description: tunnel.description ?? undefined,
  ttl: tunnel.ttl ?? undefined,
  mtu: tunnel.mtu ?? undefined,
  createdOn: tunnel.createdOn ?? undefined,
  modifiedOn: tunnel.modifiedOn ?? undefined,
});
