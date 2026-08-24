import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { DeviceDefaultProfile } from "./DefaultProfile.ts";

const TypeId = "Cloudflare.Devices.CustomProfile" as const;
type TypeId = typeof TypeId;

/**
 * Configuration for a WARP custom device profile.
 *
 * A custom profile applies its settings to the subset of devices matched
 * by the `match` wirefilter expression, evaluated in ascending
 * `precedence` order. Devices not matched by any custom profile fall back
 * to the account's default profile.
 */
export interface DeviceCustomProfileProps {
  /**
   * Name of the device settings profile. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The wirefilter expression to match devices, e.g.
   * `identity.email == "user@example.com"` or `os.name == "windows"`.
   * Mutable — patched in place.
   */
  match: string;
  /**
   * The precedence of the profile. Lower values indicate higher
   * precedence; profiles are evaluated in ascending order. Must be
   * unique within the account.
   */
  precedence: number;
  /**
   * Whether the profile is applied to matching devices.
   * @default true
   */
  enabled?: boolean;
  /**
   * A human-readable description of the profile.
   */
  description?: string;
  /**
   * Routes that WARP will tunnel for matched devices. Mutually exclusive
   * with {@link exclude}. Pushed to the per-profile include list endpoint.
   */
  include?: DeviceDefaultProfile.SplitTunnelEntry[];
  /**
   * Routes that WARP will bypass for matched devices. Mutually exclusive
   * with {@link include}. Pushed to the per-profile exclude list endpoint.
   */
  exclude?: DeviceDefaultProfile.SplitTunnelEntry[];
  /**
   * Local-fallback DNS suffixes for matched devices. For each suffix,
   * WARP resolves matching names via the given DNS servers.
   */
  fallbackDomains?: DeviceDefaultProfile.FallbackDomain[];
  /**
   * Seconds to wait before activating the captive-portal bypass. A value
   * of `0` disables the bypass.
   */
  captivePortal?: number;
  /**
   * Seconds to wait before WARP reconnects after the user disables it.
   * `0` keeps WARP disabled until the user re-enables it.
   */
  autoConnect?: number;
  /**
   * Whether the user is allowed to remove the device from the team.
   */
  allowedToLeave?: boolean;
  /**
   * Whether the user is allowed to switch WARP between Gateway-with-WARP
   * and other modes.
   */
  allowModeSwitch?: boolean;
  /**
   * Whether WARP should surface available client updates to the user.
   */
  allowUpdates?: boolean;
  /**
   * When `true`, fallback domains without an explicit `dnsServer` are NOT
   * resolved via the system resolver — WARP refuses to resolve them.
   */
  disableAutoFallback?: boolean;
  /**
   * When `true`, Microsoft 365 service IP ranges are added to the
   * split-tunnel exclude list automatically.
   */
  excludeOfficeIps?: boolean;
  /**
   * When `true`, the user cannot turn the WARP switch off.
   */
  switchLocked?: boolean;
  /**
   * Selects WARP's tunneling behavior: `"warp"` for the full WireGuard
   * tunnel, `"proxy"` for a local SOCKS proxy on the chosen `port`.
   */
  serviceModeV2?: DeviceDefaultProfile.ServiceModeV2;
  /**
   * Minutes of LAN access permitted after a WARP reconnect. `0` means
   * unrestricted until the next WARP cycle.
   */
  lanAllowMinutes?: number;
  /**
   * Prefix length of the LAN subnet that {@link lanAllowMinutes} applies
   * to (e.g. `24` for a `/24`).
   */
  lanAllowSubnetSize?: number;
  /**
   * When `true`, the OS registers WARP's local interface IP with the
   * on-premises DNS server.
   */
  registerInterfaceIpWithDns?: boolean;
  /**
   * When `true`, WARP signals SCCM that the device is inside a VPN
   * boundary. Windows only.
   */
  sccmVpnBoundarySupport?: boolean;
  /**
   * URL launched when the user clicks "Send Feedback" in the client.
   */
  supportUrl?: string;
  /**
   * Which underlying tunnel protocol WARP should use (e.g. `"wireguard"`,
   * `"masque"`).
   */
  tunnelProtocol?: string;
}

export type DeviceCustomProfileAttributes = {
  /** API UUID of the profile. */
  policyId: string;
  /** Account that owns the profile. */
  accountId: string;
  /** Observed profile name. */
  name: string;
  /** Observed wirefilter match expression. */
  match: string | undefined;
  /** Observed precedence. */
  precedence: number | undefined;
  /** Whether the profile is applied to matching devices. */
  enabled: boolean | undefined;
  /** Observed description. */
  description: string | undefined;
  /** Always `false` — custom profiles are never the default profile. */
  default: boolean;
  /** Observed per-profile split-tunnel include list. */
  include: DeviceDefaultProfile.SplitTunnelEntry[];
  /** Observed per-profile split-tunnel exclude list. */
  exclude: DeviceDefaultProfile.SplitTunnelEntry[];
  /** Observed per-profile fallback domains. */
  fallbackDomains: DeviceDefaultProfile.FallbackDomain[];
  /** Observed captive-portal timeout (seconds). */
  captivePortal: number | undefined;
  /** Observed auto-connect timeout (seconds). */
  autoConnect: number | undefined;
  /** Whether devices are allowed to leave the organization. */
  allowedToLeave: boolean | undefined;
  /** Whether the user may switch WARP modes. */
  allowModeSwitch: boolean | undefined;
  /** Whether update notifications are shown. */
  allowUpdates: boolean | undefined;
  /** Whether auto-fallback to system DNS is disabled. */
  disableAutoFallback: boolean | undefined;
  /** Whether Microsoft IPs are auto-excluded. */
  excludeOfficeIps: boolean | undefined;
  /** Whether the WARP switch is locked on. */
  switchLocked: boolean | undefined;
  /** Tunneling mode configuration. */
  serviceModeV2: DeviceDefaultProfile.ServiceModeV2 | undefined;
  /** Whether the WARP IP is registered with the on-prem DNS server. */
  registerInterfaceIpWithDns: boolean | undefined;
  /** Whether SCCM VPN-boundary support is enabled. */
  sccmVpnBoundarySupport: boolean | undefined;
  /** Send-Feedback URL. */
  supportUrl: string | undefined;
  /** Tunnel protocol selection. */
  tunnelProtocol: string | undefined;
};

export type DeviceCustomProfile = Resource<
  TypeId,
  DeviceCustomProfileProps,
  DeviceCustomProfileAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare WARP **custom device profile** — a settings profile applied
 * to the subset of devices matched by a wirefilter `match` expression at a
 * given `precedence`.
 *
 * All properties are mutable in place: the profile itself is patched, and
 * the per-profile split-tunnel include/exclude and fallback-domain lists
 * are replaced via their dedicated endpoints. Deleting the resource
 * deletes the profile; matched devices fall back to the account's default
 * profile.
 * @resource
 * @product Devices
 * @category Cloudflare One (Zero Trust)
 * @section Creating a profile
 * @example Profile for a user group
 * ```typescript
 * const profile = yield* Cloudflare.Devices.DeviceCustomProfile("Contractors", {
 *   match: 'identity.groups.name == "contractors"',
 *   precedence: 100,
 *   description: "Locked-down profile for contractors",
 *   switchLocked: true,
 * });
 * ```
 *
 * @section Split tunneling
 * @example Exclude internal ranges from the tunnel
 * ```typescript
 * yield* Cloudflare.Devices.DeviceCustomProfile("Engineering", {
 *   match: 'identity.groups.name == "engineering"',
 *   precedence: 50,
 *   exclude: [
 *     { address: "10.0.0.0/8", description: "RFC1918" },
 *   ],
 * });
 * ```
 *
 * @section Fallback domains
 * @example Resolve a private suffix via an on-prem DNS server
 * ```typescript
 * yield* Cloudflare.Devices.DeviceCustomProfile("CorpDns", {
 *   match: 'identity.email matches ".*@corp.example.com"',
 *   precedence: 10,
 *   fallbackDomains: [
 *     { suffix: "corp.example.com", dnsServer: ["10.0.0.53"] },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/device-profiles/
 */
export const DeviceCustomProfile = Resource<DeviceCustomProfile>(TypeId);

/**
 * Returns true if the given value is a DeviceCustomProfile resource.
 */
export const isDeviceCustomProfile = (
  value: unknown,
): value is DeviceCustomProfile =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DeviceCustomProfileProvider = () =>
  Provider.succeed(DeviceCustomProfile, {
    stables: ["policyId", "accountId", "default"],

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted policy id.
      if (output?.policyId) {
        const observed = yield* observeProfile(acct, output.policyId);
        return observed ? yield* buildAttrs(acct, observed) : undefined;
      }

      // Cold lookup: recover from lost state by exact name. Profile names
      // carry no ownership markers, so brand the match `Unowned` and let
      // the engine gate takeover behind the adopt policy.
      const name = yield* createProfileName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match?.policyId) {
        const observed = yield* observeProfile(acct, match.policyId);
        if (observed) return Unowned(yield* buildAttrs(acct, observed));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createProfileName(id, news.name);

      // 1. Observe — the policy id cached on `output` is a hint, not a
      //    guarantee: a missing profile falls through to create.
      let observed = output?.policyId
        ? yield* observeProfile(accountId, output.policyId)
        : undefined;

      // 2. Ensure — create when missing. Names are not unique on
      //    Cloudflare's side, so there is no AlreadyExists race; a
      //    precedence collision is a real validation error and propagates.
      if (!observed) {
        const created = yield* zeroTrust.createDevicePolicyCustom({
          accountId,
          name,
          match: news.match,
          precedence: news.precedence,
          enabled: news.enabled,
          description: news.description,
          include: news.include?.map(encodeSplit),
          exclude: news.exclude?.map(encodeSplit),
          captivePortal: news.captivePortal,
          autoConnect: news.autoConnect,
          allowedToLeave: news.allowedToLeave,
          allowModeSwitch: news.allowModeSwitch,
          allowUpdates: news.allowUpdates,
          disableAutoFallback: news.disableAutoFallback,
          excludeOfficeIps: news.excludeOfficeIps,
          switchLocked: news.switchLocked,
          serviceModeV2: news.serviceModeV2,
          lanAllowMinutes: news.lanAllowMinutes,
          lanAllowSubnetSize: news.lanAllowSubnetSize,
          registerInterfaceIpWithDns: news.registerInterfaceIpWithDns,
          sccmVpnBoundarySupport: news.sccmVpnBoundarySupport,
          supportUrl: news.supportUrl,
          tunnelProtocol: news.tunnelProtocol,
        });
        const policyId = created?.policyId;
        if (!policyId) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare did not return a policy id for the created custom device profile",
            ),
          );
        }
        observed = yield* observeProfile(accountId, policyId);
        if (!observed) {
          return yield* Effect.fail(
            new Error(
              `custom device profile ${policyId} disappeared right after create`,
            ),
          );
        }
      }
      const policyId = observed.policyId!;

      // 3. Sync (a) — patch the profile body with only the changed fields.
      const patch: zeroTrust.PatchDevicePolicyCustomRequest = {
        accountId,
        policyId,
      };
      let dirty = false;
      const setIf = <
        K extends Exclude<
          keyof zeroTrust.PatchDevicePolicyCustomRequest,
          "accountId" | "policyId"
        >,
      >(
        key: K,
        desired: zeroTrust.PatchDevicePolicyCustomRequest[K],
        observedValue: unknown,
      ) => {
        if (desired === undefined) return;
        if (!sameJSON(desired, observedValue)) {
          patch[key] = desired;
          dirty = true;
        }
      };
      setIf("name", name, observed.name ?? undefined);
      setIf("match", news.match, denull(observed.match));
      setIf("precedence", news.precedence, denull(observed.precedence));
      setIf("enabled", news.enabled, denull(observed.enabled));
      setIf("description", news.description, denull(observed.description));
      setIf(
        "captivePortal",
        news.captivePortal,
        denull(observed.captivePortal),
      );
      setIf("autoConnect", news.autoConnect, denull(observed.autoConnect));
      setIf(
        "allowedToLeave",
        news.allowedToLeave,
        denull(observed.allowedToLeave),
      );
      setIf(
        "allowModeSwitch",
        news.allowModeSwitch,
        denull(observed.allowModeSwitch),
      );
      setIf("allowUpdates", news.allowUpdates, denull(observed.allowUpdates));
      setIf(
        "disableAutoFallback",
        news.disableAutoFallback,
        denull(observed.disableAutoFallback),
      );
      setIf(
        "excludeOfficeIps",
        news.excludeOfficeIps,
        denull(observed.excludeOfficeIps),
      );
      setIf("switchLocked", news.switchLocked, denull(observed.switchLocked));
      setIf(
        "registerInterfaceIpWithDns",
        news.registerInterfaceIpWithDns,
        denull(observed.registerInterfaceIpWithDns),
      );
      setIf(
        "sccmVpnBoundarySupport",
        news.sccmVpnBoundarySupport,
        denull(observed.sccmVpnBoundarySupport),
      );
      setIf("supportUrl", news.supportUrl, denull(observed.supportUrl));
      setIf(
        "tunnelProtocol",
        news.tunnelProtocol,
        denull(observed.tunnelProtocol),
      );
      if (
        news.serviceModeV2 !== undefined &&
        !sameJSON(
          news.serviceModeV2,
          normalizeServiceMode(observed.serviceModeV2),
        )
      ) {
        patch.serviceModeV2 = news.serviceModeV2;
        dirty = true;
      }
      // lanAllow* are accepted by PATCH but not reliably echoed on GET,
      // so push them whenever the user sets them — the API is idempotent.
      if (news.lanAllowMinutes !== undefined) {
        patch.lanAllowMinutes = news.lanAllowMinutes;
        dirty = true;
      }
      if (news.lanAllowSubnetSize !== undefined) {
        patch.lanAllowSubnetSize = news.lanAllowSubnetSize;
        dirty = true;
      }
      if (dirty) {
        yield* zeroTrust.patchDevicePolicyCustom(patch);
      }

      // 3. Sync (b) — replace the per-profile lists when they differ from
      //    the observed cloud state.
      const lists = yield* observeLists(accountId, policyId);
      if (
        news.include !== undefined &&
        !sameJSON(news.include, lists.include)
      ) {
        yield* zeroTrust.putDevicePolicyCustomInclude({
          accountId,
          policyId,
          body: news.include.map(encodeSplit),
        });
      }
      if (
        news.exclude !== undefined &&
        !sameJSON(news.exclude, lists.exclude)
      ) {
        yield* zeroTrust.putDevicePolicyCustomExclude({
          accountId,
          policyId,
          body: news.exclude.map(encodeSplit),
        });
      }
      if (
        news.fallbackDomains !== undefined &&
        !sameJSON(news.fallbackDomains, lists.fallbackDomains)
      ) {
        yield* zeroTrust.putDevicePolicyCustomFallbackDomain({
          accountId,
          policyId,
          domains: news.fallbackDomains.map(encodeFallback),
        });
      }

      // 4. Return — re-read so attrs reflect post-sync truth.
      const final = yield* observeProfile(accountId, policyId);
      if (!final) {
        return yield* Effect.fail(
          new Error(
            `custom device profile ${policyId} disappeared during reconcile`,
          ),
        );
      }
      return yield* buildAttrs(accountId, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteDevicePolicyCustom({
          accountId: output.accountId,
          policyId: output.policyId,
        })
        .pipe(Effect.catchTag("DevicePolicyNotFound", () => Effect.void));
    }),

    // Account collection: enumerate every custom device profile in the
    // ambient account, then hydrate each into the exact `read` Attributes
    // shape (same `observeProfile` + `buildAttrs` path read uses, so the
    // per-profile split-tunnel/fallback lists are fetched too). Bounded
    // concurrency keeps the fan-out polite; a profile that vanishes
    // mid-enumeration is dropped via the typed `DevicePolicyNotFound` map.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const items = yield* zeroTrust.listDevicePolicyCustoms
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.result ?? []),
          ),
        );
      const rows = yield* Effect.forEach(
        items.filter((p) => p.policyId != null),
        (p) =>
          Effect.gen(function* () {
            const observed = yield* observeProfile(accountId, p.policyId!);
            return observed
              ? yield* buildAttrs(accountId, observed)
              : undefined;
          }),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is DeviceCustomProfileAttributes => row !== undefined,
      );
    }),
  });

type ObservedProfile = NonNullable<zeroTrust.GetDevicePolicyCustomResponse>;

/**
 * Read a custom profile by id, mapping "gone" (`DevicePolicyNotFound`,
 * Cloudflare error code 2052) to `undefined`.
 */
const observeProfile = (accountId: string, policyId: string) =>
  zeroTrust.getDevicePolicyCustom({ accountId, policyId }).pipe(
    Effect.map((p): ObservedProfile | undefined => p ?? undefined),
    Effect.catchTag("DevicePolicyNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Read the three per-profile list endpoints.
 */
const observeLists = Effect.fn(function* (accountId: string, policyId: string) {
  const [include, exclude, fallback] = yield* Effect.all(
    [
      zeroTrust.getDevicePolicyCustomInclude({ accountId, policyId }),
      zeroTrust.getDevicePolicyCustomExclude({ accountId, policyId }),
      zeroTrust.getDevicePolicyCustomFallbackDomain({ accountId, policyId }),
    ],
    { concurrency: "unbounded" },
  );
  return {
    include: (include.result ?? []).map(normalizeSplit),
    exclude: (exclude.result ?? []).map(normalizeSplit),
    fallbackDomains: (fallback.result ?? []).map(normalizeFallback),
  };
});

/**
 * Find a profile by exact name via the list endpoint (oldest-id-first for
 * determinism when names collide).
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listDevicePolicyCustoms.items({ accountId }).pipe(
    Stream.filter((p) => p.name === name && p.policyId != null),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.policyId ?? "").localeCompare(b.policyId ?? ""))
        .at(0),
    ),
  );

const createProfileName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const buildAttrs = Effect.fn(function* (
  accountId: string,
  profile: ObservedProfile,
) {
  const policyId = profile.policyId!;
  const lists = yield* observeLists(accountId, policyId);
  const attrs: DeviceCustomProfileAttributes = {
    policyId,
    accountId,
    name: profile.name ?? "",
    match: denull(profile.match),
    precedence: denull(profile.precedence),
    enabled: denull(profile.enabled),
    description: denull(profile.description),
    default: profile.default ?? false,
    include: lists.include,
    exclude: lists.exclude,
    fallbackDomains: lists.fallbackDomains,
    captivePortal: denull(profile.captivePortal),
    autoConnect: denull(profile.autoConnect),
    allowedToLeave: denull(profile.allowedToLeave),
    allowModeSwitch: denull(profile.allowModeSwitch),
    allowUpdates: denull(profile.allowUpdates),
    disableAutoFallback: denull(profile.disableAutoFallback),
    excludeOfficeIps: denull(profile.excludeOfficeIps),
    switchLocked: denull(profile.switchLocked),
    serviceModeV2: normalizeServiceMode(profile.serviceModeV2),
    registerInterfaceIpWithDns: denull(profile.registerInterfaceIpWithDns),
    sccmVpnBoundarySupport: denull(profile.sccmVpnBoundarySupport),
    supportUrl: denull(profile.supportUrl),
    tunnelProtocol: denull(profile.tunnelProtocol),
  };
  return attrs;
});

/**
 * Strip Cloudflare's `null` echoes to `undefined` so structural equality
 * (`JSON.stringify`) works.
 */
const denull = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const normalizeServiceMode = (
  sm: { mode?: string | null; port?: number | null } | null | undefined,
): DeviceDefaultProfile.ServiceModeV2 | undefined =>
  sm && sm.mode != null
    ? {
        mode: (sm.mode === "proxy" ? "proxy" : "warp") as "warp" | "proxy",
        port: denull(sm.port),
      }
    : undefined;

const normalizeSplit = (
  entry:
    | { address: string; description?: string | null }
    | { host: string; description?: string | null },
): DeviceDefaultProfile.SplitTunnelEntry => ({
  address: "address" in entry ? entry.address : "",
  host: "host" in entry ? entry.host : undefined,
  description: denull(entry.description),
});

const normalizeFallback = (entry: {
  suffix: string;
  description?: string | null;
  dnsServer?: string[] | null;
}): DeviceDefaultProfile.FallbackDomain => ({
  suffix: entry.suffix,
  description: denull(entry.description),
  dnsServer: denull(entry.dnsServer),
});

/**
 * Encode a SplitTunnelEntry for the API's union shape (`address` OR `host`).
 * Prefers `host` when set since the address would otherwise be empty.
 */
const encodeSplit = (
  e: DeviceDefaultProfile.SplitTunnelEntry,
):
  | { address: string; description?: string }
  | { host: string; description?: string } => {
  if (e.host && !e.address) {
    return e.description !== undefined
      ? { host: e.host, description: e.description }
      : { host: e.host };
  }
  return e.description !== undefined
    ? { address: e.address, description: e.description }
    : { address: e.address };
};

const encodeFallback = (
  d: DeviceDefaultProfile.FallbackDomain,
): { suffix: string; description?: string; dnsServer?: string[] } => {
  const out: { suffix: string; description?: string; dnsServer?: string[] } = {
    suffix: d.suffix,
  };
  if (d.description !== undefined) out.description = d.description;
  if (d.dnsServer !== undefined) out.dnsServer = d.dnsServer;
  return out;
};

/** Structural deep-equality via canonical JSON. */
const sameJSON = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
