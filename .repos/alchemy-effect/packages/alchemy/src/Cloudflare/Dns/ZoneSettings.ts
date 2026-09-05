import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.DNS.ZoneSettings" as const;
type TypeId = typeof TypeId;

/**
 * Nameserver assignment for the zone. `custom.*` types require
 * Business/Enterprise account-level custom nameservers (ACNS).
 */
export interface ZoneDnsNameservers {
  /**
   * Nameserver kind: Cloudflare's standard pair, or custom nameservers
   * defined at the account, tenant, or zone level.
   */
  type:
    | "cloudflare.standard"
    | "custom.account"
    | "custom.tenant"
    | "custom.zone"
    | (string & {});
  /**
   * Which configured nameserver set to use (for `custom.account` /
   * `custom.tenant`).
   */
  nsSet?: number;
}

/**
 * Components of the zone's SOA record. Every field is optional —
 * omitted fields keep their current value.
 */
export interface ZoneDnsSoa {
  /** Time in seconds after which secondaries stop answering (`expire`). */
  expire?: number;
  /** Negative-caching TTL in seconds (`minimum`). */
  minTtl?: number;
  /** Primary nameserver (`MNAME`). */
  mname?: string;
  /** Secondary refresh interval in seconds. */
  refresh?: number;
  /** Secondary retry interval in seconds. */
  retry?: number;
  /** Zone administrator mailbox (`RNAME`). */
  rname?: string;
  /** TTL of the SOA record itself. */
  ttl?: number;
}

export interface ZoneDnsSettingsProps {
  /**
   * Zone whose DNS settings are managed. Stable — the settings object
   * is a per-zone singleton, so changing the zone triggers a
   * replacement (the old zone's managed settings are restored to their
   * pre-management values).
   */
  zoneId: string;
  /**
   * Flatten all CNAME records in the zone (a CNAME at the zone apex is
   * always flattened regardless).
   *
   * Mutable — patched in place.
   *
   * @default false
   */
  flattenAllCnames?: boolean;
  /**
   * Enable Foundation DNS Advanced Nameservers (paid add-on — patching
   * `true` fails without the entitlement).
   *
   * Mutable — patched in place.
   *
   * @default false
   */
  foundationDns?: boolean;
  /**
   * Settings for internal zones (Enterprise Internal DNS only).
   *
   * Mutable — patched in place.
   */
  internalDns?: {
    /** Zone to resolve from when this internal zone has no match. */
    referenceZoneId?: string;
  };
  /**
   * Enable multi-provider DNS — activates the zone even when
   * non-Cloudflare NS records exist and respects apex NS records during
   * outbound zone transfers.
   *
   * Mutable — patched in place.
   *
   * @default false
   */
  multiProvider?: boolean;
  /**
   * Nameservers through which the zone should be available.
   *
   * Mutable — patched in place.
   *
   * @default { type: "cloudflare.standard" }
   */
  nameservers?: ZoneDnsNameservers;
  /**
   * TTL (seconds) of the zone's NS records.
   *
   * Mutable — patched in place.
   *
   * @default 86400
   */
  nsTtl?: number;
  /**
   * Allow a secondary zone to use proxied override records and CNAME
   * flattening at the apex (secondary zones only).
   *
   * Mutable — patched in place.
   *
   * @default false
   */
  secondaryOverrides?: boolean;
  /**
   * Components of the zone's SOA record. Only the fields you provide
   * are compared and patched; the rest keep their live values.
   *
   * Mutable — patched in place.
   */
  soa?: ZoneDnsSoa;
  /**
   * Whether the zone is a regular, CDN-only, or DNS-only zone.
   *
   * Mutable — patched in place.
   *
   * @default "standard"
   */
  zoneMode?: "standard" | "cdn_only" | "dns_only";
}

/**
 * Fully-resolved snapshot of a zone's DNS settings as Cloudflare
 * reports them (`GET /zones/{zone_id}/dns_settings`).
 */
export interface ZoneDnsSettingsSnapshot {
  /** Whether all CNAMEs are flattened. */
  flattenAllCnames: boolean;
  /** Whether Foundation DNS is enabled. */
  foundationDns: boolean;
  /** Internal DNS reference zone, if configured. */
  internalDns: { referenceZoneId: string | undefined };
  /** Whether multi-provider DNS is enabled. */
  multiProvider: boolean;
  /** Resolved nameserver assignment. */
  nameservers: { type: string; nsSet: number | undefined };
  /** TTL of the zone's NS records. */
  nsTtl: number;
  /** Whether secondary overrides are enabled. */
  secondaryOverrides: boolean;
  /** Resolved SOA components. */
  soa: {
    expire: number | undefined;
    minTtl: number | undefined;
    mname: string | undefined;
    refresh: number | undefined;
    retry: number | undefined;
    rname: string | undefined;
    ttl: number | undefined;
  };
  /** Zone mode. */
  zoneMode: string;
}

export interface ZoneDnsSettingsAttributes extends ZoneDnsSettingsSnapshot {
  /** Zone whose DNS settings are managed. */
  zoneId: string;
  /**
   * Snapshot of every DNS setting taken before Alchemy first patched
   * the zone. The managed fields are restored from it on destroy, so
   * deleting the resource puts the zone back the way it was found.
   */
  initialSettings: ZoneDnsSettingsSnapshot;
  /**
   * Which top-level settings this resource has managed (union across
   * all reconciles). Only these are restored on destroy — settings the
   * user never touched are left alone.
   */
  managedKeys: ReadonlyArray<string>;
}

export type ZoneDnsSettings = Resource<
  TypeId,
  ZoneDnsSettingsProps,
  ZoneDnsSettingsAttributes,
  never,
  Providers
>;

/**
 * The DNS settings of a Cloudflare zone
 * (`/zones/{zone_id}/dns_settings`) — nameserver assignment, NS TTL,
 * SOA components, CNAME flattening, multi-provider mode, and zone mode.
 *
 * The settings object is a per-zone singleton — it always exists with
 * Cloudflare defaults, so this resource never creates or deletes
 * anything physical. Reconcile patches only the fields you declare
 * (and only when the observed value differs); destroy restores the
 * managed fields to the values they had before Alchemy first touched
 * the zone (captured as `initialSettings`).
 *
 * Some fields are plan-gated: `foundationDns` is a paid add-on,
 * `nameservers.type: "custom.*"` requires account custom nameservers,
 * `internalDns` and `secondaryOverrides` are Enterprise features.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Basic settings
 * @example Lower the NS record TTL
 * ```typescript
 * yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
 *   zoneId: zone.zoneId,
 *   nsTtl: 3600,
 * });
 * ```
 *
 * @example Flatten every CNAME in the zone
 * ```typescript
 * yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
 *   zoneId: zone.zoneId,
 *   flattenAllCnames: true,
 * });
 * ```
 *
 * @section SOA tuning
 * @example Shorten the negative-caching TTL
 * ```typescript
 * yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
 *   zoneId: zone.zoneId,
 *   soa: { minTtl: 300 },
 * });
 * ```
 *
 * @section Multi-provider DNS
 * @example Serve the zone alongside another DNS provider
 * ```typescript
 * yield* Cloudflare.DNS.ZoneDnsSettings("DnsSettings", {
 *   zoneId: zone.zoneId,
 *   multiProvider: true,
 * });
 * ```
 */
export const ZoneDnsSettings = Resource<ZoneDnsSettings>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneSettings"],
});

/**
 * Returns true if the given value is a ZoneDnsSettings resource.
 */
export const isZoneDnsSettings = (value: unknown): value is ZoneDnsSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneDnsSettingsProvider = () =>
  Provider.succeed(ZoneDnsSettings, {
    stables: ["zoneId", "initialSettings", "managedKeys"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The settings object is a per-zone singleton with no account-wide
      // list API — enumerate every zone and read its settings (every live
      // zone always has one). Unmanaged here, so the observed snapshot is
      // both the current state and the captured baseline.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          dns.getSettingZone({ zoneId }).pipe(
            Effect.map((observed) => {
              const snapshot = toSnapshot(observed);
              const attributes: ZoneDnsSettingsAttributes = {
                zoneId,
                ...snapshot,
                initialSettings: snapshot,
                managedKeys: [],
              };
              return attributes;
            }),
            // Plan-gated or partial zones reject the route; skip them.
            // (Transient 403/429 "Authentication error" blips under
            // concurrency are retried globally by the Cloudflare retry policy,
            // so they never reach here as a real failure.)
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is ZoneDnsSettingsAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ZoneDnsSettingsProps;
      const n = news as ZoneDnsSettingsProps;
      // zoneId is the resource's identity (the settings object is a
      // zone singleton). Input<string> — compare only once concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;
      const observed = yield* dns.getSettingZone({ zoneId }).pipe(
        // Zone deleted out-of-band — its settings are gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      const snapshot = toSnapshot(observed);
      // Settings are a singleton that always exists with Cloudflare
      // defaults — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed snapshot at adoption
      // time becomes the baseline restored on destroy.
      return {
        zoneId,
        ...snapshot,
        initialSettings: output?.initialSettings ?? snapshot,
        managedKeys: output?.managedKeys ?? [],
      } satisfies ZoneDnsSettingsAttributes;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the settings object always exists for a live zone.
      const observed = yield* dns.getSettingZone({ zoneId });
      let snapshot = toSnapshot(observed);

      // 2. Capture — the pre-management snapshot, restored on destroy.
      const initialSettings = output?.initialSettings ?? snapshot;
      // Track every key we have ever managed so destroy restores fields
      // even after the user drops them from props.
      const managedKeys = [
        ...new Set([...(output?.managedKeys ?? []), ...declaredKeys(news)]),
      ].sort();

      // 3. Sync — patch only the declared fields whose observed value
      //    differs from the desired one; skip the API on no delta.
      const delta = computeDelta(news, snapshot);
      if (delta !== undefined) {
        const patched = yield* dns.patchSettingZone({ zoneId, ...delta });
        snapshot = toSnapshot(patched);
      }

      return {
        zoneId,
        ...snapshot,
        initialSettings,
        managedKeys,
      } satisfies ZoneDnsSettingsAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialSettings, managedKeys } = output;
      // Observe — if the zone itself is gone, so are its settings.
      const observed = yield* dns
        .getSettingZone({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      const snapshot = toSnapshot(observed);
      // Restore only the fields this resource managed, and only the
      // ones that still differ (idempotent re-delete after a crash).
      const restore = computeRestore(managedKeys, initialSettings, snapshot);
      if (restore === undefined) return;
      yield* dns
        .patchSettingZone({ zoneId, ...restore })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

// ---------------------------------------------------------------------------
// Snapshot + diff helpers
// ---------------------------------------------------------------------------

type SettingsResponse =
  | dns.GetSettingZoneResponse
  | dns.PatchSettingZoneResponse;

type PatchBody = Omit<dns.PatchSettingZoneRequest, "zoneId">;

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const toSnapshot = (r: SettingsResponse): ZoneDnsSettingsSnapshot => ({
  flattenAllCnames: r.flattenAllCnames,
  foundationDns: r.foundationDns,
  internalDns: { referenceZoneId: undef(r.internalDns.referenceZoneId) },
  multiProvider: r.multiProvider,
  nameservers: {
    type: r.nameservers.type,
    nsSet: undef(r.nameservers.nsSet),
  },
  nsTtl: r.nsTtl,
  secondaryOverrides: r.secondaryOverrides,
  soa: {
    expire: undef(r.soa.expire),
    minTtl: undef(r.soa.minTtl),
    mname: undef(r.soa.mname),
    refresh: undef(r.soa.refresh),
    retry: undef(r.soa.retry),
    rname: undef(r.soa.rname),
    ttl: undef(r.soa.ttl),
  },
  zoneMode: r.zoneMode,
});

/** Top-level prop keys (besides `zoneId`) the user declared. */
const declaredKeys = (news: ZoneDnsSettingsProps): string[] =>
  (
    [
      "flattenAllCnames",
      "foundationDns",
      "internalDns",
      "multiProvider",
      "nameservers",
      "nsTtl",
      "secondaryOverrides",
      "soa",
      "zoneMode",
    ] as const
  ).filter((k) => news[k] !== undefined);

/**
 * Merge desired SOA subfields over the observed SOA so the PATCH always
 * carries a complete, consistent record (Cloudflare validates SOA as a
 * whole). Drops fields that are unknown on both sides.
 */
const mergedSoa = (
  desired: ZoneDnsSoa,
  observed: ZoneDnsSettingsSnapshot["soa"],
): NonNullable<PatchBody["soa"]> => ({
  expire: desired.expire ?? observed.expire,
  minTtl: desired.minTtl ?? observed.minTtl,
  mname: desired.mname ?? observed.mname,
  refresh: desired.refresh ?? observed.refresh,
  retry: desired.retry ?? observed.retry,
  rname: desired.rname ?? observed.rname,
  ttl: desired.ttl ?? observed.ttl,
});

const soaDiffers = (
  desired: ZoneDnsSoa,
  observed: ZoneDnsSettingsSnapshot["soa"],
): boolean =>
  (desired.expire !== undefined && desired.expire !== observed.expire) ||
  (desired.minTtl !== undefined && desired.minTtl !== observed.minTtl) ||
  (desired.mname !== undefined && desired.mname !== observed.mname) ||
  (desired.refresh !== undefined && desired.refresh !== observed.refresh) ||
  (desired.retry !== undefined && desired.retry !== observed.retry) ||
  (desired.rname !== undefined && desired.rname !== observed.rname) ||
  (desired.ttl !== undefined && desired.ttl !== observed.ttl);

const nameserversDiffer = (
  desired: ZoneDnsNameservers,
  observed: ZoneDnsSettingsSnapshot["nameservers"],
): boolean =>
  desired.type !== observed.type ||
  (desired.nsSet !== undefined && desired.nsSet !== observed.nsSet);

/**
 * Build the PATCH body converging observed → desired for the fields the
 * user declared. Returns `undefined` when nothing differs.
 */
const computeDelta = (
  news: ZoneDnsSettingsProps,
  observed: ZoneDnsSettingsSnapshot,
): PatchBody | undefined => {
  const body: PatchBody = {};
  let dirty = false;
  if (
    news.flattenAllCnames !== undefined &&
    news.flattenAllCnames !== observed.flattenAllCnames
  ) {
    body.flattenAllCnames = news.flattenAllCnames;
    dirty = true;
  }
  if (
    news.foundationDns !== undefined &&
    news.foundationDns !== observed.foundationDns
  ) {
    body.foundationDns = news.foundationDns;
    dirty = true;
  }
  if (
    news.internalDns?.referenceZoneId !== undefined &&
    news.internalDns.referenceZoneId !== observed.internalDns.referenceZoneId
  ) {
    body.internalDns = { referenceZoneId: news.internalDns.referenceZoneId };
    dirty = true;
  }
  if (
    news.multiProvider !== undefined &&
    news.multiProvider !== observed.multiProvider
  ) {
    body.multiProvider = news.multiProvider;
    dirty = true;
  }
  if (
    news.nameservers !== undefined &&
    nameserversDiffer(news.nameservers, observed.nameservers)
  ) {
    body.nameservers = {
      type: news.nameservers.type,
      nsSet: news.nameservers.nsSet,
    };
    dirty = true;
  }
  if (news.nsTtl !== undefined && news.nsTtl !== observed.nsTtl) {
    body.nsTtl = news.nsTtl;
    dirty = true;
  }
  if (
    news.secondaryOverrides !== undefined &&
    news.secondaryOverrides !== observed.secondaryOverrides
  ) {
    body.secondaryOverrides = news.secondaryOverrides;
    dirty = true;
  }
  if (news.soa !== undefined && soaDiffers(news.soa, observed.soa)) {
    body.soa = mergedSoa(news.soa, observed.soa);
    dirty = true;
  }
  if (news.zoneMode !== undefined && news.zoneMode !== observed.zoneMode) {
    body.zoneMode = news.zoneMode;
    dirty = true;
  }
  return dirty ? body : undefined;
};

/**
 * Build the PATCH body that restores the managed fields to their
 * pre-management values. Returns `undefined` when nothing drifted.
 */
const computeRestore = (
  managedKeys: ReadonlyArray<string>,
  initial: ZoneDnsSettingsSnapshot,
  observed: ZoneDnsSettingsSnapshot,
): PatchBody | undefined => {
  const body: PatchBody = {};
  let dirty = false;
  for (const key of managedKeys) {
    switch (key) {
      case "flattenAllCnames":
        if (initial.flattenAllCnames !== observed.flattenAllCnames) {
          body.flattenAllCnames = initial.flattenAllCnames;
          dirty = true;
        }
        break;
      case "foundationDns":
        if (initial.foundationDns !== observed.foundationDns) {
          body.foundationDns = initial.foundationDns;
          dirty = true;
        }
        break;
      case "internalDns":
        if (
          initial.internalDns.referenceZoneId !==
            observed.internalDns.referenceZoneId &&
          initial.internalDns.referenceZoneId !== undefined
        ) {
          body.internalDns = {
            referenceZoneId: initial.internalDns.referenceZoneId,
          };
          dirty = true;
        }
        break;
      case "multiProvider":
        if (initial.multiProvider !== observed.multiProvider) {
          body.multiProvider = initial.multiProvider;
          dirty = true;
        }
        break;
      case "nameservers":
        if (
          initial.nameservers.type !== observed.nameservers.type ||
          initial.nameservers.nsSet !== observed.nameservers.nsSet
        ) {
          body.nameservers = {
            type: initial.nameservers.type,
            nsSet: initial.nameservers.nsSet,
          };
          dirty = true;
        }
        break;
      case "nsTtl":
        if (initial.nsTtl !== observed.nsTtl) {
          body.nsTtl = initial.nsTtl;
          dirty = true;
        }
        break;
      case "secondaryOverrides":
        if (initial.secondaryOverrides !== observed.secondaryOverrides) {
          body.secondaryOverrides = initial.secondaryOverrides;
          dirty = true;
        }
        break;
      case "soa":
        if (
          initial.soa.expire !== observed.soa.expire ||
          initial.soa.minTtl !== observed.soa.minTtl ||
          initial.soa.mname !== observed.soa.mname ||
          initial.soa.refresh !== observed.soa.refresh ||
          initial.soa.retry !== observed.soa.retry ||
          initial.soa.rname !== observed.soa.rname ||
          initial.soa.ttl !== observed.soa.ttl
        ) {
          body.soa = {
            expire: initial.soa.expire,
            minTtl: initial.soa.minTtl,
            mname: initial.soa.mname,
            refresh: initial.soa.refresh,
            retry: initial.soa.retry,
            rname: initial.soa.rname,
            ttl: initial.soa.ttl,
          };
          dirty = true;
        }
        break;
      case "zoneMode":
        if (initial.zoneMode !== observed.zoneMode) {
          body.zoneMode = initial.zoneMode;
          dirty = true;
        }
        break;
      default:
        break;
    }
  }
  return dirty ? body : undefined;
};
