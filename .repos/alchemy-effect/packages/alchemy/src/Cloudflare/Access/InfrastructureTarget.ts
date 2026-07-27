import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Access.InfrastructureTarget" as const;
type TypeId = typeof TypeId;

/**
 * IPv4/IPv6 address details for an infrastructure target. At least one
 * of `ipv4` / `ipv6` must be provided.
 */
export interface InfrastructureTargetIp {
  /** IPv4 address of the target, optionally scoped to a virtual network. */
  ipv4?: {
    /** The IPv4 address (e.g. `10.0.0.5`). */
    ipAddr: string;
    /**
     * Virtual network the address lives in. Defaults to the account's
     * default virtual network.
     */
    virtualNetworkId?: string;
  };
  /** IPv6 address of the target, optionally scoped to a virtual network. */
  ipv6?: {
    /** The IPv6 address. */
    ipAddr: string;
    /**
     * Virtual network the address lives in. Defaults to the account's
     * default virtual network.
     */
    virtualNetworkId?: string;
  };
}

export interface InfrastructureTargetProps {
  /**
   * Hostname identifying the target. Non-unique, case-insensitive, max
   * 255 characters; supports dashes and periods, no spaces. Mutable —
   * updated in place via PUT.
   */
  hostname: string;
  /**
   * The IPv4/IPv6 address that identifies where to reach the target. At
   * least one of `ipv4` / `ipv6` is required. Mutable — updated in
   * place via PUT.
   */
  ip: InfrastructureTargetIp;
}

export interface InfrastructureTargetAttributes {
  /** UUID of the infrastructure target, assigned by Cloudflare. */
  targetId: string;
  /** Cloudflare account that owns the target. */
  accountId: string;
  /** Hostname identifying the target. */
  hostname: string;
  /** Resolved IPv4/IPv6 addresses of the target. */
  ip: {
    ipv4?: { ipAddr?: string; virtualNetworkId?: string };
    ipv6?: { ipAddr?: string; virtualNetworkId?: string };
  };
  /** RFC 3339 timestamp of when the target was created. */
  createdAt: string;
  /** RFC 3339 timestamp of when the target was last modified. */
  modifiedAt: string;
}

export type InfrastructureTarget = Resource<
  TypeId,
  InfrastructureTargetProps,
  InfrastructureTargetAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Access Infrastructure Target — a server (hostname +
 * IPv4/IPv6 address) protected by Access for Infrastructure (SSH).
 *
 * Targets are referenced by infrastructure Access applications, which
 * attach SSH access policies to them. Hostname and IP are both mutable
 * in place; the target's identity is its Cloudflare-assigned UUID.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Target
 * @example Basic IPv4 target
 * ```typescript
 * const target = yield* Cloudflare.Access.InfrastructureTarget("Bastion", {
 *   hostname: "bastion.internal",
 *   ip: { ipv4: { ipAddr: "10.0.0.5" } },
 * });
 * ```
 *
 * @example Target scoped to a virtual network
 * ```typescript
 * const vnet = yield* Cloudflare.Tunnel.VirtualNetwork("Staging", {});
 * const target = yield* Cloudflare.Access.InfrastructureTarget("DbHost", {
 *   hostname: "db.staging.internal",
 *   ip: {
 *     ipv4: {
 *       ipAddr: "10.4.0.10",
 *       virtualNetworkId: vnet.virtualNetworkId,
 *     },
 *   },
 * });
 * ```
 *
 * @section Updating
 * @example Re-point the target at a new address
 * ```typescript
 * // Hostname and IP update in place — same targetId, no replacement.
 * const target = yield* Cloudflare.Access.InfrastructureTarget("Bastion", {
 *   hostname: "bastion.internal",
 *   ip: { ipv4: { ipAddr: "10.0.0.6" } },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/applications/non-http/infrastructure-apps/
 */
export const InfrastructureTarget = Resource<InfrastructureTarget>(TypeId);

/**
 * Returns true if the given value is an InfrastructureTarget resource.
 */
export const isInfrastructureTarget = (
  value: unknown,
): value is InfrastructureTarget =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const InfrastructureTargetProvider = () =>
  Provider.succeed(InfrastructureTarget, {
    stables: ["targetId", "accountId", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessInfrastructureTargets
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((t) => toAttributes(t, accountId)),
            ),
          ),
        );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // hostname / ip both converge via PUT.
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached id.
      if (output?.targetId) {
        const observed = yield* getTarget(acct, output.targetId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold read — hostnames are non-unique, so only an exact
      // hostname + address match identifies the target. Targets carry no
      // ownership markers, so gate adoption behind Unowned.
      const hostname = olds?.hostname ?? output?.hostname;
      if (!hostname) return undefined;
      // `olds.ip` may be `undefined` when a `creating` row was persisted
      // before upstream Outputs resolved — fall back to the output hint.
      const desiredIp =
        olds?.ip !== undefined ? resolvedIp(olds.ip) : output?.ip;
      const match = yield* findByIdentity(acct, hostname, desiredIp);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const desired = { hostname: news.hostname, ip: resolvedIp(news.ip) };

      // 1. Observe — the cached id is a hint, not a guarantee.
      let observed = output?.targetId
        ? yield* getTarget(accountId, output.targetId)
        : undefined;
      if (!observed) {
        observed = yield* findByIdentity(
          accountId,
          desired.hostname,
          desired.ip,
        );
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        observed = yield* zeroTrust.createAccessInfrastructureTarget({
          accountId,
          hostname: desired.hostname,
          ip: desired.ip,
        });
      }

      // 3. Sync — PUT the full desired state only when the observed
      //    hostname or addresses differ; skip the call on a no-op.
      const dirty =
        observed.hostname !== desired.hostname ||
        !ipEquals(observedIp(observed), desired.ip);
      if (dirty) {
        observed = yield* zeroTrust.updateAccessInfrastructureTarget({
          accountId,
          targetId: observed.id,
          hostname: desired.hostname,
          ip: desired.ip,
        });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A missing target (404) means we're done.
      yield* zeroTrust
        .deleteAccessInfrastructureTarget({
          accountId: output.accountId,
          targetId: output.targetId,
        })
        .pipe(Effect.catchTag("TargetNotFound", () => Effect.void));
    }),
  });

type ObservedTarget = zeroTrust.GetAccessInfrastructureTargetResponse;

type ResolvedIp = {
  ipv4?: { ipAddr?: string; virtualNetworkId?: string };
  ipv6?: { ipAddr?: string; virtualNetworkId?: string };
};

/**
 * Read a target by id, mapping "gone" (404) to `undefined`.
 */
const getTarget = (accountId: string, targetId: string) =>
  zeroTrust
    .getAccessInfrastructureTarget({ accountId, targetId })
    .pipe(Effect.catchTag("TargetNotFound", () => Effect.succeed(undefined)));

/**
 * Find a target by exact hostname + address match. Hostnames are
 * non-unique, so the addresses disambiguate.
 */
const findByIdentity = (
  accountId: string,
  hostname: string,
  ip: ResolvedIp | undefined,
) =>
  zeroTrust.listAccessInfrastructureTargets.items({ accountId, hostname }).pipe(
    Stream.filter(
      (t) =>
        t.hostname === hostname &&
        (ip === undefined || ipEquals(observedIp(t), ip)),
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

/**
 * Narrow the props' `ip` (whose virtualNetworkIds are `Input`s already
 * resolved to strings by Plan) to the concrete wire shape.
 */
const resolvedIp = (ip: InfrastructureTargetIp): ResolvedIp => ({
  ...(ip.ipv4
    ? {
        ipv4: {
          ipAddr: ip.ipv4.ipAddr,
          ...(typeof ip.ipv4.virtualNetworkId === "string"
            ? { virtualNetworkId: ip.ipv4.virtualNetworkId }
            : {}),
        },
      }
    : {}),
  ...(ip.ipv6
    ? {
        ipv6: {
          ipAddr: ip.ipv6.ipAddr,
          ...(typeof ip.ipv6.virtualNetworkId === "string"
            ? { virtualNetworkId: ip.ipv6.virtualNetworkId }
            : {}),
        },
      }
    : {}),
});

const observedIp = (t: {
  ip: {
    ipv4?: { ipAddr?: string | null; virtualNetworkId?: string | null } | null;
    ipv6?: { ipAddr?: string | null; virtualNetworkId?: string | null } | null;
  };
}): ResolvedIp => ({
  ...(t.ip.ipv4
    ? {
        ipv4: {
          ipAddr: t.ip.ipv4.ipAddr ?? undefined,
          ...(t.ip.ipv4.virtualNetworkId
            ? { virtualNetworkId: t.ip.ipv4.virtualNetworkId }
            : {}),
        },
      }
    : {}),
  ...(t.ip.ipv6
    ? {
        ipv6: {
          ipAddr: t.ip.ipv6.ipAddr ?? undefined,
          ...(t.ip.ipv6.virtualNetworkId
            ? { virtualNetworkId: t.ip.ipv6.virtualNetworkId }
            : {}),
        },
      }
    : {}),
});

/**
 * Compare two address blocks. A `virtualNetworkId` left undefined in the
 * desired state matches any observed value (Cloudflare fills in the
 * account's default virtual network).
 */
const ipEquals = (observed: ResolvedIp, desired: ResolvedIp): boolean =>
  familyEquals(observed.ipv4, desired.ipv4) &&
  familyEquals(observed.ipv6, desired.ipv6);

const familyEquals = (
  observed: { ipAddr?: string; virtualNetworkId?: string } | undefined,
  desired: { ipAddr?: string; virtualNetworkId?: string } | undefined,
): boolean => {
  if (desired === undefined) return observed === undefined;
  if (observed === undefined) return false;
  if (observed.ipAddr !== desired.ipAddr) return false;
  if (
    desired.virtualNetworkId !== undefined &&
    observed.virtualNetworkId !== desired.virtualNetworkId
  ) {
    return false;
  }
  return true;
};

const toAttributes = (
  target: ObservedTarget,
  accountId: string,
): InfrastructureTargetAttributes => ({
  targetId: target.id,
  accountId,
  hostname: target.hostname,
  ip: observedIp(target),
  createdAt: target.createdAt,
  modifiedAt: target.modifiedAt,
});
