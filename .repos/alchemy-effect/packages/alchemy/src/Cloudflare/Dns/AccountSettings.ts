import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DNS.AccountSettings" as const;
type TypeId = typeof TypeId;

/**
 * Default nameserver assignment for new zones in the account.
 */
export interface AccountDnsNameservers {
  /**
   * Nameserver kind: Cloudflare's standard pair, a random standard
   * assignment, or custom nameservers defined at the account or tenant
   * level.
   */
  type:
    | "cloudflare.standard"
    | "cloudflare.standard.random"
    | "custom.account"
    | "custom.tenant"
    | (string & {});
}

/**
 * Components of the default SOA record for new zones. Every field is
 * optional — omitted fields keep their current value.
 */
export interface AccountDnsSoa {
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

/**
 * Default DNS settings applied to new zones in the account. Only the
 * fields you provide are compared and patched.
 */
export interface AccountDnsZoneDefaults {
  /**
   * Flatten all CNAME records by default.
   * @default false
   */
  flattenAllCnames?: boolean;
  /**
   * Enable Foundation DNS Advanced Nameservers by default (paid
   * add-on).
   * @default false
   */
  foundationDns?: boolean;
  /**
   * Default settings for internal zones (Enterprise Internal DNS only).
   */
  internalDns?: {
    /** Zone to resolve from when an internal zone has no match. */
    referenceZoneId?: string;
  };
  /**
   * Enable multi-provider DNS by default.
   * @default false
   */
  multiProvider?: boolean;
  /**
   * Default nameserver assignment for new zones.
   * @default { type: "cloudflare.standard" }
   */
  nameservers?: AccountDnsNameservers;
  /**
   * Default TTL (seconds) of zones' NS records.
   * @default 86400
   */
  nsTtl?: number;
  /**
   * Allow secondary zones to use proxied override records and CNAME
   * flattening at the apex by default.
   * @default false
   */
  secondaryOverrides?: boolean;
  /**
   * Components of the default SOA record for new zones.
   */
  soa?: AccountDnsSoa;
  /**
   * Default zone mode for new zones.
   * @default "standard"
   */
  zoneMode?: "standard" | "cdn_only" | "dns_only";
}

export interface AccountDnsSettingsProps {
  /**
   * Force all proxied DNS records in the account to behave as DNS-only
   * at the edge, regardless of each record's individual proxy setting.
   *
   * Mutable — patched in place.
   * @default false
   */
  enforceDnsOnly?: boolean;
  /**
   * Default DNS settings applied to new zones created in the account.
   * Only the fields you declare are compared and patched; the rest keep
   * their live values.
   *
   * Mutable — patched in place.
   */
  zoneDefaults?: AccountDnsZoneDefaults;
}

/**
 * Fully-resolved snapshot of the account's DNS settings as Cloudflare
 * reports them (`GET /accounts/{account_id}/dns_settings`).
 */
export interface AccountDnsSettingsSnapshot {
  /** Whether proxied records are forced to DNS-only. */
  enforceDnsOnly: boolean;
  /** Resolved zone defaults. */
  zoneDefaults: {
    /** Whether all CNAMEs are flattened by default. */
    flattenAllCnames: boolean;
    /** Whether Foundation DNS is enabled by default. */
    foundationDns: boolean;
    /** Default internal DNS reference zone, if configured. */
    internalDns: { referenceZoneId: string | undefined };
    /** Whether multi-provider DNS is enabled by default. */
    multiProvider: boolean;
    /** Default nameserver assignment. */
    nameservers: { type: string };
    /** Default TTL of zones' NS records. */
    nsTtl: number;
    /** Whether secondary overrides are enabled by default. */
    secondaryOverrides: boolean;
    /** Resolved default SOA components. */
    soa: {
      expire: number | undefined;
      minTtl: number | undefined;
      mname: string | undefined;
      refresh: number | undefined;
      retry: number | undefined;
      rname: string | undefined;
      ttl: number | undefined;
    };
    /** Default zone mode. */
    zoneMode: string;
  };
}

export interface AccountDnsSettingsAttributes extends AccountDnsSettingsSnapshot {
  /** The Cloudflare account whose DNS settings are managed. */
  accountId: string;
  /**
   * Snapshot of every DNS setting taken before Alchemy first patched
   * the account. The managed fields are restored from it on destroy, so
   * deleting the resource puts the account back the way it was found.
   */
  initialSettings: AccountDnsSettingsSnapshot;
  /**
   * Which settings this resource has managed (union across all
   * reconciles). Only these are restored on destroy — settings the user
   * never touched are left alone.
   */
  managedKeys: ReadonlyArray<string>;
}

export type AccountDnsSettings = Resource<
  TypeId,
  AccountDnsSettingsProps,
  AccountDnsSettingsAttributes,
  never,
  Providers
>;

/**
 * The DNS settings of a Cloudflare account
 * (`/accounts/{account_id}/dns_settings`) — the account-wide
 * `enforceDnsOnly` override and the default DNS settings applied to
 * every new zone (`zoneDefaults`).
 *
 * The settings object is a per-account singleton — it always exists
 * with Cloudflare defaults, so this resource never creates or deletes
 * anything physical. Reconcile patches only the fields you declare
 * (and only when the observed value differs); destroy restores the
 * managed fields to the values they had before Alchemy first touched
 * the account (captured as `initialSettings`).
 *
 * Some fields are plan-gated: `zoneDefaults.nsTtl` and custom SOA
 * values require the custom nameserver TTL / custom SOA entitlements,
 * `foundationDns` is a paid add-on, and `internalDns` is Enterprise
 * Internal DNS only.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Account-wide overrides
 * @example Force every proxied record to DNS-only
 * ```typescript
 * yield* Cloudflare.DNS.AccountDnsSettings("DnsSettings", {
 *   enforceDnsOnly: true,
 * });
 * ```
 *
 * @section Zone defaults
 * @example Flatten CNAMEs in every new zone
 * ```typescript
 * yield* Cloudflare.DNS.AccountDnsSettings("DnsSettings", {
 *   zoneDefaults: { flattenAllCnames: true },
 * });
 * ```
 *
 * @example Default new zones to multi-provider DNS
 * ```typescript
 * yield* Cloudflare.DNS.AccountDnsSettings("DnsSettings", {
 *   zoneDefaults: { multiProvider: true },
 * });
 * ```
 */
export const AccountDnsSettings = Resource<AccountDnsSettings>(TypeId, {
  aliases: ["Cloudflare.Dns.AccountSettings"],
});

/**
 * Returns true if the given value is an AccountDnsSettings resource.
 */
export const isAccountDnsSettings = (
  value: unknown,
): value is AccountDnsSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AccountDnsSettingsProvider = () =>
  Provider.succeed(AccountDnsSettings, {
    stables: ["accountId", "initialSettings", "managedKeys"],

    // Account singleton — the DNS settings object always exists for the
    // ambient account. There is no enumeration API, so read the single
    // object and return it as a one-element array (mirrors `read` with no
    // prior output: the observed snapshot is its own `initialSettings`,
    // nothing is being managed yet).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* dns.getSettingAccount({ accountId });
      const snapshot = toSnapshot(observed);
      return [
        {
          accountId,
          ...snapshot,
          initialSettings: snapshot,
          managedKeys: [],
        } satisfies AccountDnsSettingsAttributes,
      ];
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The settings object is an account singleton — a different
      // account is a different resource.
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = yield* dns.getSettingAccount({ accountId: acct });
      const snapshot = toSnapshot(observed);
      // Settings are a singleton that always exists with Cloudflare
      // defaults — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed snapshot at adoption
      // time becomes the baseline restored on destroy.
      return {
        accountId: acct,
        ...snapshot,
        initialSettings: output?.initialSettings ?? snapshot,
        managedKeys: output?.managedKeys ?? [],
      } satisfies AccountDnsSettingsAttributes;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the settings object always exists for an account.
      const observed = yield* dns.getSettingAccount({ accountId });
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
        const patched = yield* dns.patchSettingAccount({
          accountId,
          ...delta,
        });
        snapshot = toSnapshot(patched);
      }

      return {
        accountId,
        ...snapshot,
        initialSettings,
        managedKeys,
      } satisfies AccountDnsSettingsAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, initialSettings, managedKeys } = output;
      // Observe, then restore only the fields this resource managed,
      // and only the ones that still differ (idempotent re-delete after
      // a crash).
      const observed = yield* dns.getSettingAccount({ accountId });
      const snapshot = toSnapshot(observed);
      const restore = computeRestore(managedKeys, initialSettings, snapshot);
      if (restore === undefined) return;
      yield* dns.patchSettingAccount({ accountId, ...restore });
    }),
  });

// ---------------------------------------------------------------------------
// Snapshot + diff helpers
// ---------------------------------------------------------------------------

type SettingsResponse =
  | dns.GetSettingAccountResponse
  | dns.PatchSettingAccountResponse;

type PatchBody = Omit<dns.PatchSettingAccountRequest, "accountId">;
type ZoneDefaultsPatch = NonNullable<PatchBody["zoneDefaults"]>;

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const toSnapshot = (r: SettingsResponse): AccountDnsSettingsSnapshot => ({
  enforceDnsOnly: undef(r.enforceDnsOnly) ?? false,
  zoneDefaults: {
    flattenAllCnames: r.zoneDefaults.flattenAllCnames,
    foundationDns: r.zoneDefaults.foundationDns,
    internalDns: {
      referenceZoneId: undef(r.zoneDefaults.internalDns.referenceZoneId),
    },
    multiProvider: r.zoneDefaults.multiProvider,
    nameservers: { type: r.zoneDefaults.nameservers.type },
    nsTtl: r.zoneDefaults.nsTtl,
    secondaryOverrides: r.zoneDefaults.secondaryOverrides,
    soa: {
      expire: undef(r.zoneDefaults.soa.expire),
      minTtl: undef(r.zoneDefaults.soa.minTtl),
      mname: undef(r.zoneDefaults.soa.mname),
      refresh: undef(r.zoneDefaults.soa.refresh),
      retry: undef(r.zoneDefaults.soa.retry),
      rname: undef(r.zoneDefaults.soa.rname),
      ttl: undef(r.zoneDefaults.soa.ttl),
    },
    zoneMode: r.zoneDefaults.zoneMode,
  },
});

const ZONE_DEFAULT_KEYS = [
  "flattenAllCnames",
  "foundationDns",
  "internalDns",
  "multiProvider",
  "nameservers",
  "nsTtl",
  "secondaryOverrides",
  "soa",
  "zoneMode",
] as const;

/** Keys the user declared, e.g. `enforceDnsOnly`, `zoneDefaults.nsTtl`. */
const declaredKeys = (news: AccountDnsSettingsProps): string[] => [
  ...(news.enforceDnsOnly !== undefined ? ["enforceDnsOnly"] : []),
  ...ZONE_DEFAULT_KEYS.filter((k) => news.zoneDefaults?.[k] !== undefined).map(
    (k) => `zoneDefaults.${k}`,
  ),
];

/**
 * Merge desired SOA subfields over the observed SOA so the PATCH always
 * carries a complete, consistent record (Cloudflare validates SOA as a
 * whole).
 */
const mergedSoa = (
  desired: AccountDnsSoa,
  observed: AccountDnsSettingsSnapshot["zoneDefaults"]["soa"],
): NonNullable<ZoneDefaultsPatch["soa"]> => ({
  expire: desired.expire ?? observed.expire,
  minTtl: desired.minTtl ?? observed.minTtl,
  mname: desired.mname ?? observed.mname,
  refresh: desired.refresh ?? observed.refresh,
  retry: desired.retry ?? observed.retry,
  rname: desired.rname ?? observed.rname,
  ttl: desired.ttl ?? observed.ttl,
});

const soaDiffers = (
  desired: AccountDnsSoa,
  observed: AccountDnsSettingsSnapshot["zoneDefaults"]["soa"],
): boolean =>
  (desired.expire !== undefined && desired.expire !== observed.expire) ||
  (desired.minTtl !== undefined && desired.minTtl !== observed.minTtl) ||
  (desired.mname !== undefined && desired.mname !== observed.mname) ||
  (desired.refresh !== undefined && desired.refresh !== observed.refresh) ||
  (desired.retry !== undefined && desired.retry !== observed.retry) ||
  (desired.rname !== undefined && desired.rname !== observed.rname) ||
  (desired.ttl !== undefined && desired.ttl !== observed.ttl);

/**
 * Build the PATCH body converging observed → desired for the fields the
 * user declared. Returns `undefined` when nothing differs.
 */
const computeDelta = (
  news: AccountDnsSettingsProps,
  observed: AccountDnsSettingsSnapshot,
): PatchBody | undefined => {
  const body: PatchBody = {};
  let dirty = false;
  if (
    news.enforceDnsOnly !== undefined &&
    news.enforceDnsOnly !== observed.enforceDnsOnly
  ) {
    body.enforceDnsOnly = news.enforceDnsOnly;
    dirty = true;
  }
  const zd = news.zoneDefaults;
  const ozd = observed.zoneDefaults;
  if (zd !== undefined) {
    const zdBody: ZoneDefaultsPatch = {};
    let zdDirty = false;
    if (
      zd.flattenAllCnames !== undefined &&
      zd.flattenAllCnames !== ozd.flattenAllCnames
    ) {
      zdBody.flattenAllCnames = zd.flattenAllCnames;
      zdDirty = true;
    }
    if (
      zd.foundationDns !== undefined &&
      zd.foundationDns !== ozd.foundationDns
    ) {
      zdBody.foundationDns = zd.foundationDns;
      zdDirty = true;
    }
    if (
      zd.internalDns?.referenceZoneId !== undefined &&
      zd.internalDns.referenceZoneId !== ozd.internalDns.referenceZoneId
    ) {
      zdBody.internalDns = { referenceZoneId: zd.internalDns.referenceZoneId };
      zdDirty = true;
    }
    if (
      zd.multiProvider !== undefined &&
      zd.multiProvider !== ozd.multiProvider
    ) {
      zdBody.multiProvider = zd.multiProvider;
      zdDirty = true;
    }
    if (
      zd.nameservers !== undefined &&
      zd.nameservers.type !== ozd.nameservers.type
    ) {
      zdBody.nameservers = { type: zd.nameservers.type };
      zdDirty = true;
    }
    if (zd.nsTtl !== undefined && zd.nsTtl !== ozd.nsTtl) {
      zdBody.nsTtl = zd.nsTtl;
      zdDirty = true;
    }
    if (
      zd.secondaryOverrides !== undefined &&
      zd.secondaryOverrides !== ozd.secondaryOverrides
    ) {
      zdBody.secondaryOverrides = zd.secondaryOverrides;
      zdDirty = true;
    }
    if (zd.soa !== undefined && soaDiffers(zd.soa, ozd.soa)) {
      zdBody.soa = mergedSoa(zd.soa, ozd.soa);
      zdDirty = true;
    }
    if (zd.zoneMode !== undefined && zd.zoneMode !== ozd.zoneMode) {
      zdBody.zoneMode = zd.zoneMode;
      zdDirty = true;
    }
    if (zdDirty) {
      body.zoneDefaults = zdBody;
      dirty = true;
    }
  }
  return dirty ? body : undefined;
};

/**
 * Build the PATCH body that restores the managed fields to their
 * pre-management values. Returns `undefined` when nothing drifted.
 */
const computeRestore = (
  managedKeys: ReadonlyArray<string>,
  initial: AccountDnsSettingsSnapshot,
  observed: AccountDnsSettingsSnapshot,
): PatchBody | undefined => {
  const body: PatchBody = {};
  const zdBody: ZoneDefaultsPatch = {};
  let dirty = false;
  let zdDirty = false;
  const izd = initial.zoneDefaults;
  const ozd = observed.zoneDefaults;
  for (const key of managedKeys) {
    switch (key) {
      case "enforceDnsOnly":
        if (initial.enforceDnsOnly !== observed.enforceDnsOnly) {
          body.enforceDnsOnly = initial.enforceDnsOnly;
          dirty = true;
        }
        break;
      case "zoneDefaults.flattenAllCnames":
        if (izd.flattenAllCnames !== ozd.flattenAllCnames) {
          zdBody.flattenAllCnames = izd.flattenAllCnames;
          zdDirty = true;
        }
        break;
      case "zoneDefaults.foundationDns":
        if (izd.foundationDns !== ozd.foundationDns) {
          zdBody.foundationDns = izd.foundationDns;
          zdDirty = true;
        }
        break;
      case "zoneDefaults.internalDns":
        if (
          izd.internalDns.referenceZoneId !== ozd.internalDns.referenceZoneId &&
          izd.internalDns.referenceZoneId !== undefined
        ) {
          zdBody.internalDns = {
            referenceZoneId: izd.internalDns.referenceZoneId,
          };
          zdDirty = true;
        }
        break;
      case "zoneDefaults.multiProvider":
        if (izd.multiProvider !== ozd.multiProvider) {
          zdBody.multiProvider = izd.multiProvider;
          zdDirty = true;
        }
        break;
      case "zoneDefaults.nameservers":
        if (izd.nameservers.type !== ozd.nameservers.type) {
          zdBody.nameservers = { type: izd.nameservers.type };
          zdDirty = true;
        }
        break;
      case "zoneDefaults.nsTtl":
        if (izd.nsTtl !== ozd.nsTtl) {
          zdBody.nsTtl = izd.nsTtl;
          zdDirty = true;
        }
        break;
      case "zoneDefaults.secondaryOverrides":
        if (izd.secondaryOverrides !== ozd.secondaryOverrides) {
          zdBody.secondaryOverrides = izd.secondaryOverrides;
          zdDirty = true;
        }
        break;
      case "zoneDefaults.soa":
        if (
          izd.soa.expire !== ozd.soa.expire ||
          izd.soa.minTtl !== ozd.soa.minTtl ||
          izd.soa.mname !== ozd.soa.mname ||
          izd.soa.refresh !== ozd.soa.refresh ||
          izd.soa.retry !== ozd.soa.retry ||
          izd.soa.rname !== ozd.soa.rname ||
          izd.soa.ttl !== ozd.soa.ttl
        ) {
          zdBody.soa = {
            expire: izd.soa.expire,
            minTtl: izd.soa.minTtl,
            mname: izd.soa.mname,
            refresh: izd.soa.refresh,
            retry: izd.soa.retry,
            rname: izd.soa.rname,
            ttl: izd.soa.ttl,
          };
          zdDirty = true;
        }
        break;
      case "zoneDefaults.zoneMode":
        if (izd.zoneMode !== ozd.zoneMode) {
          zdBody.zoneMode = izd.zoneMode;
          zdDirty = true;
        }
        break;
      default:
        break;
    }
  }
  if (zdDirty) {
    body.zoneDefaults = zdBody;
    dirty = true;
  }
  return dirty ? body : undefined;
};
