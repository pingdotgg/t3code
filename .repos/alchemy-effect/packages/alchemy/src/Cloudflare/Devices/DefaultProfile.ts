import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Configuration for the singleton WARP default device profile.
 *
 * Every Cloudflare Zero Trust account has exactly one default device
 * profile that applies to all WARP devices not matched by a custom
 * profile. This shape mirrors the fields supported by
 * `PATCH /accounts/{accountId}/devices/policy` plus the three list
 * endpoints for the split-tunnel include/exclude and fallback domains.
 */
export interface DeviceDefaultProfileProps {
  /**
   * Split-tunnel mode. `"include"` routes only listed CIDRs/hostnames
   * through WARP; `"exclude"` routes everything except listed entries.
   *
   * The Cloudflare backend stores the include and exclude lists
   * independently — only the list matching the active mode is enforced
   * at runtime. We always push both lists when supplied so toggling
   * `mode` is non-destructive.
   *
   * @default "exclude"
   */
  mode?: "include" | "exclude";
  /**
   * Routes that WARP will tunnel. Only effective when {@link mode} is
   * `"include"`. Pushed to `PUT /devices/policy/include`.
   */
  splitTunnelInclude?: DeviceDefaultProfile.SplitTunnelEntry[];
  /**
   * Routes that WARP will bypass. Only effective when {@link mode} is
   * `"exclude"`. Pushed to `PUT /devices/policy/exclude`.
   */
  splitTunnelExclude?: DeviceDefaultProfile.SplitTunnelEntry[];
  /**
   * Local-fallback DNS suffixes. For each suffix, WARP will resolve
   * matching names via the given DNS servers (or the system resolver
   * when omitted and {@link disableAutoFallback} is `false`).
   */
  fallbackDomains?: DeviceDefaultProfile.FallbackDomain[];
  /**
   * Seconds to wait before activating the captive-portal bypass. A
   * value of `0` disables the bypass.
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
   * When `true`, fallback domains without an explicit `dnsServer` are
   * NOT resolved via the system resolver — WARP refuses to resolve them.
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
   * Selects WARP's tunneling behavior:
   * - `"warp"` — full WireGuard tunnel
   * - `"proxy"` — local SOCKS proxy on the chosen `port`
   */
  serviceModeV2?: DeviceDefaultProfile.ServiceModeV2;
  /**
   * Minutes of LAN access permitted after a WARP reconnect. `0` means
   * unrestricted until the next WARP cycle.
   */
  lanAllowMinutes?: number;
  /**
   * Prefix length of the LAN subnet that {@link lanAllowMinutes}
   * applies to (e.g. `24` for a `/24`).
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

export declare namespace DeviceDefaultProfile {
  /**
   * One entry in either the split-tunnel include or exclude list.
   * Either an `address` (CIDR) or a `host` (DNS name) is required.
   */
  export interface SplitTunnelEntry {
    /** CIDR-form route, e.g. `"10.0.0.0/8"` or `"1.2.3.4/32"`. */
    address: string;
    /** Hostname-form route, e.g. `"example.com"`. */
    host?: string;
    /** Free-form description shown in the dashboard. */
    description?: string;
  }
  /**
   * Local-fallback DNS configuration for a given DNS suffix.
   */
  export interface FallbackDomain {
    /** DNS suffix, e.g. `"corp.example.com"`. */
    suffix: string;
    /** Optional free-form description. */
    description?: string;
    /** DNS resolvers (IPv4/IPv6) used for names matching `suffix`. */
    dnsServer?: string[];
  }
  /**
   * Tunneling-mode configuration.
   */
  export interface ServiceModeV2 {
    /** `"warp"` for the full WireGuard tunnel, `"proxy"` for SOCKS. */
    mode: "warp" | "proxy";
    /** Local SOCKS port when `mode === "proxy"`. Ignored otherwise. */
    port?: number;
  }
}

export type DeviceDefaultProfile = Resource<
  "Cloudflare.Devices.DefaultProfile",
  DeviceDefaultProfileProps,
  {
    /** Account that owns the default profile. */
    accountId: string;
    /** Observed split-tunnel mode. */
    mode: "include" | "exclude";
    /** Observed include list. */
    splitTunnelInclude: DeviceDefaultProfile.SplitTunnelEntry[];
    /** Observed exclude list. */
    splitTunnelExclude: DeviceDefaultProfile.SplitTunnelEntry[];
    /** Observed fallback domains. */
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
    /** LAN-access allowance (minutes). */
    lanAllowMinutes: number | undefined;
    /** LAN subnet prefix length. */
    lanAllowSubnetSize: number | undefined;
    /** Whether the WARP IP is registered with the on-prem DNS server. */
    registerInterfaceIpWithDns: boolean | undefined;
    /** Whether SCCM VPN-boundary support is enabled. */
    sccmVpnBoundarySupport: boolean | undefined;
    /** Send-Feedback URL. */
    supportUrl: string | undefined;
    /** Tunnel protocol selection. */
    tunnelProtocol: string | undefined;
  },
  never,
  Providers
>;

/**
 * Manages the **singleton** Cloudflare WARP **default device profile** for
 * an account. The default profile applies to every WARP device not
 * matched by a custom profile.
 * @resource
 * @product Devices
 * @category Cloudflare One (Zero Trust)
 * @remarks
 * There is exactly one default profile per account; it cannot be created
 * or deleted. Reconciling this resource patches the existing profile in
 * place and synchronizes the four sibling list endpoints (include,
 * exclude, fallback domains). The `delete` lifecycle is a deliberate
 * no-op — destroying the Alchemy resource only removes our local state,
 * the cloud profile remains intact.
 *
 * Custom (non-default) profiles are a separate resource.
 *
 * @section Configuring split tunneling
 * @example Exclude-mode (default): tunnel everything except listed routes
 * ```typescript
 * yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
 *   mode: "exclude",
 *   splitTunnelExclude: [
 *     { address: "10.0.0.0/8", description: "RFC1918" },
 *     { address: "192.168.0.0/16", description: "RFC1918" },
 *   ],
 *   excludeOfficeIps: true,
 * });
 * ```
 *
 * @example Include-mode: only listed routes go through WARP
 * ```typescript
 * yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
 *   mode: "include",
 *   splitTunnelInclude: [
 *     { address: "10.42.0.0/16", description: "Prod VPC" },
 *   ],
 * });
 * ```
 *
 * @section Configuring fallback domains
 * @example Resolve a private suffix via an on-prem DNS server
 * ```typescript
 * yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
 *   fallbackDomains: [
 *     {
 *       suffix: "corp.example.com",
 *       dnsServer: ["10.0.0.53"],
 *       description: "Corp AD",
 *     },
 *   ],
 *   disableAutoFallback: true,
 * });
 * ```
 */
export const DeviceDefaultProfile = Resource<DeviceDefaultProfile>(
  "Cloudflare.Devices.DefaultProfile",
);

/**
 * Live `Provider` for {@link DeviceDefaultProfile}. Wire into a Cloudflare
 * provider Layer with `Provider.collection([DeviceDefaultProfile])` plus
 * `DeviceDefaultProfileProvider()`.
 */
export const DeviceDefaultProfileProvider = () =>
  Provider.succeed(DeviceDefaultProfile, {
    nuke: { singleton: true },
    stables: ["accountId"],
    reconcile: Effect.fn(function* ({ news = {} }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // 1. Observe — the default profile always exists.
      let obs = yield* observe();

      // 2. Sync — four independent idempotent diffs.

      // (a) General profile patch.
      const desiredMode = news.mode ?? inferMode(obs.profile);
      const observedSm = obs.profile.serviceModeV2;
      const desiredSm = news.serviceModeV2;
      const patchBody: zeroTrust.PatchDevicePolicyDefaultRequest = {
        accountId,
      };
      let needsPatch = false;
      const setIf = <K extends keyof zeroTrust.PatchDevicePolicyDefaultRequest>(
        key: K,
        desired: zeroTrust.PatchDevicePolicyDefaultRequest[K],
        observed: unknown,
      ) => {
        if (desired === undefined) return;
        if (desired !== observed) {
          patchBody[key] = desired;
          needsPatch = true;
        }
      };
      setIf(
        "captivePortal",
        news.captivePortal,
        denull(obs.profile.captivePortal),
      );
      setIf("autoConnect", news.autoConnect, denull(obs.profile.autoConnect));
      setIf(
        "allowedToLeave",
        news.allowedToLeave,
        denull(obs.profile.allowedToLeave),
      );
      setIf(
        "allowModeSwitch",
        news.allowModeSwitch,
        denull(obs.profile.allowModeSwitch),
      );
      setIf(
        "allowUpdates",
        news.allowUpdates,
        denull(obs.profile.allowUpdates),
      );
      setIf(
        "disableAutoFallback",
        news.disableAutoFallback,
        denull(obs.profile.disableAutoFallback),
      );
      setIf(
        "excludeOfficeIps",
        news.excludeOfficeIps,
        denull(obs.profile.excludeOfficeIps),
      );
      setIf(
        "switchLocked",
        news.switchLocked,
        denull(obs.profile.switchLocked),
      );
      // lanAllowMinutes / lanAllowSubnetSize are accepted by PATCH but
      // not surfaced on GET, so we cannot diff them. Push them every
      // time the user sets them — the API is idempotent.
      if (news.lanAllowMinutes !== undefined) {
        patchBody.lanAllowMinutes = news.lanAllowMinutes;
        needsPatch = true;
      }
      if (news.lanAllowSubnetSize !== undefined) {
        patchBody.lanAllowSubnetSize = news.lanAllowSubnetSize;
        needsPatch = true;
      }
      setIf(
        "registerInterfaceIpWithDns",
        news.registerInterfaceIpWithDns,
        denull(obs.profile.registerInterfaceIpWithDns),
      );
      setIf(
        "sccmVpnBoundarySupport",
        news.sccmVpnBoundarySupport,
        denull(obs.profile.sccmVpnBoundarySupport),
      );
      setIf("supportUrl", news.supportUrl, denull(obs.profile.supportUrl));
      setIf(
        "tunnelProtocol",
        news.tunnelProtocol,
        denull(obs.profile.tunnelProtocol),
      );

      if (
        desiredSm !== undefined &&
        !sameJSON(
          desiredSm,
          observedSm
            ? {
                mode: denull(observedSm.mode),
                port: denull(observedSm.port),
              }
            : undefined,
        )
      ) {
        patchBody.serviceModeV2 = desiredSm;
        needsPatch = true;
      }

      // `mode` is a derived view of which list is enforced; the CF
      // PATCH endpoint surfaces it as a SIDE-EFFECT of which array
      // (`include`/`exclude`) is non-empty. We let the include/exclude
      // sync blocks below handle persistence.
      void desiredMode;

      if (needsPatch) {
        yield* zeroTrust.patchDevicePolicyDefault(patchBody);
      }

      // (b) Include list.
      if (news.splitTunnelInclude !== undefined) {
        const desired = news.splitTunnelInclude;
        if (!sameJSON(desired, obs.splitTunnelInclude)) {
          yield* zeroTrust.putDevicePolicyDefaultInclude({
            accountId,
            body: desired.map(encodeSplit),
          });
        }
      }

      // (c) Exclude list.
      if (news.splitTunnelExclude !== undefined) {
        const desired = news.splitTunnelExclude;
        if (!sameJSON(desired, obs.splitTunnelExclude)) {
          yield* zeroTrust.putDevicePolicyDefaultExclude({
            accountId,
            body: desired.map(encodeSplit),
          });
        }
      }

      // (d) Fallback domains.
      if (news.fallbackDomains !== undefined) {
        const desired = news.fallbackDomains;
        if (!sameJSON(desired, obs.fallbackDomains)) {
          yield* zeroTrust.putDevicePolicyDefaultFallbackDomain({
            accountId,
            domains: desired.map(encodeFallback),
          });
        }
      }

      // 3. Re-observe so attrs reflect post-sync truth.
      obs = yield* observe();
      return buildAttrs(accountId, obs);
    }),
    delete: Effect.fn(function* () {
      // The default device profile cannot be deleted. Drop our state
      // and leave the cloud profile in place.
      yield* Effect.logWarning(
        "Cloudflare.Devices.DefaultProfile: delete is a no-op; the default device profile cannot be deleted.",
      );
      return Effect.void;
    }),
    read: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const obs = yield* observe();
      return buildAttrs(accountId, obs);
    }),
    // Account-scoped singleton: there is exactly one default device profile
    // per account and no enumeration API. Mirror `read` and return the single
    // profile as a one-element array.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const obs = yield* observe();
      return [buildAttrs(accountId, obs)];
    }),
  });

// Cloudflare returns `{result: null, success: true}` (NOT `[]`) when
// a default-policy list endpoint is empty, and distilled's schema
// rejects that as a transport error. Swallow into `undefined` so the
// reconciler treats an empty list as "no entries" rather than failing.
const listOrEmpty = <A, Err, Req>(
  op: Effect.Effect<{ result?: readonly A[] | null }, Err, Req>,
) =>
  op.pipe(
    Effect.catch(() =>
      Effect.succeed({
        result: [] as readonly A[],
      }),
    ),
  );

const observe = Effect.fn(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const [profile, include, exclude, fallback] = yield* Effect.all(
    [
      zeroTrust.getDevicePolicyDefault({ accountId }),
      listOrEmpty(zeroTrust.getDevicePolicyDefaultInclude({ accountId })),
      listOrEmpty(zeroTrust.getDevicePolicyDefaultExclude({ accountId })),
      listOrEmpty(
        zeroTrust.getDevicePolicyDefaultFallbackDomain({ accountId }),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const inc = (include.result ?? []).map(normalizeSplit);
  const exc = (exclude.result ?? []).map(normalizeSplit);
  const fb = (fallback.result ?? []).map(normalizeFallback);
  return {
    profile,
    splitTunnelInclude: inc,
    splitTunnelExclude: exc,
    fallbackDomains: fb,
  };
});

const buildAttrs = (
  accountId: string,
  obs: Effect.Success<ReturnType<typeof observe>>,
): DeviceDefaultProfile["Attributes"] => {
  const { profile } = obs;
  const sm = profile.serviceModeV2;
  const serviceModeV2: DeviceDefaultProfile.ServiceModeV2 | undefined =
    sm && sm.mode != null
      ? {
          mode: (sm.mode === "proxy" ? "proxy" : "warp") as "warp" | "proxy",
          port: denull(sm.port),
        }
      : undefined;
  return {
    accountId,
    mode: inferMode(profile),
    splitTunnelInclude: obs.splitTunnelInclude,
    splitTunnelExclude: obs.splitTunnelExclude,
    fallbackDomains: obs.fallbackDomains,
    captivePortal: denull(profile.captivePortal),
    autoConnect: denull(profile.autoConnect),
    allowedToLeave: denull(profile.allowedToLeave),
    allowModeSwitch: denull(profile.allowModeSwitch),
    allowUpdates: denull(profile.allowUpdates),
    disableAutoFallback: denull(profile.disableAutoFallback),
    excludeOfficeIps: denull(profile.excludeOfficeIps),
    switchLocked: denull(profile.switchLocked),
    serviceModeV2,
    // lanAllow* are PATCH-only — GET does not echo them back.
    lanAllowMinutes: undefined,
    lanAllowSubnetSize: undefined,
    registerInterfaceIpWithDns: denull(profile.registerInterfaceIpWithDns),
    sccmVpnBoundarySupport: denull(profile.sccmVpnBoundarySupport),
    supportUrl: denull(profile.supportUrl),
    tunnelProtocol: denull(profile.tunnelProtocol),
  };
};

/**
 * Strip Cloudflare's `null` echoes to `undefined` so structural equality
 * (`JSON.stringify`) works.
 */
const denull = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

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

const inferMode = (observed: {
  include?: readonly unknown[] | null | undefined;
}): "include" | "exclude" =>
  observed.include && observed.include.length > 0 ? "include" : "exclude";
