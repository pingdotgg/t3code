import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Devices.Settings" as const;
type TypeId = typeof TypeId;

/**
 * A snapshot of the account's WARP device settings, as observed on
 * Cloudflare. Captured before Alchemy first patches the singleton and
 * restored on destroy.
 */
export interface DeviceSettingsSnapshot {
  /** Time limit, in seconds, that a user can bypass WARP with an override code. */
  disableForTime?: number;
  /** Whether the external emergency disconnect feature is enabled. */
  externalEmergencySignalEnabled?: boolean;
  /** SHA-256 fingerprint pinning the emergency-signal server certificate. */
  externalEmergencySignalFingerprint?: string;
  /** Polling interval for the emergency disconnect signal (e.g. `"5m"`). */
  externalEmergencySignalInterval?: string;
  /** HTTPS URL the emergency disconnect signal is fetched from. */
  externalEmergencySignalUrl?: string;
  /** Whether Gateway proxy filtering on TCP is enabled. */
  gatewayProxyEnabled?: boolean;
  /** Whether Gateway proxy filtering on UDP is enabled. */
  gatewayUdpProxyEnabled?: boolean;
  /** Whether the Cloudflare-managed root certificate is installed on devices. */
  rootCertificateInstallationEnabled?: boolean;
  /** Whether CGNAT virtual IPv4 addressing is used. */
  useZtVirtualIp?: boolean;
}

export interface DeviceSettingsProps {
  /**
   * Sets the time limit, in seconds, that a user can use an override code
   * to bypass WARP. `0` disables override codes.
   */
  disableForTime?: number;
  /**
   * Controls whether the external emergency disconnect feature is enabled.
   */
  externalEmergencySignalEnabled?: boolean;
  /**
   * The SHA-256 fingerprint (64 hexadecimal characters) of the HTTPS
   * server certificate for {@link externalEmergencySignalUrl}. When set,
   * the WARP client uses it to verify the server's identity.
   */
  externalEmergencySignalFingerprint?: string;
  /**
   * The interval at which the WARP client fetches the emergency disconnect
   * signal, as a duration string (e.g. `"5m"`, `"2m30s"`, `"1h"`).
   * Minimum 30 seconds.
   */
  externalEmergencySignalInterval?: string;
  /**
   * The HTTPS URL from which to fetch the emergency disconnect signal.
   * Must use HTTPS with an IPv4 or IPv6 address as the host.
   */
  externalEmergencySignalUrl?: string;
  /**
   * Enable Gateway proxy filtering on TCP.
   */
  gatewayProxyEnabled?: boolean;
  /**
   * Enable Gateway proxy filtering on UDP.
   */
  gatewayUdpProxyEnabled?: boolean;
  /**
   * Enable installation of the Cloudflare-managed root certificate on
   * enrolled devices.
   */
  rootCertificateInstallationEnabled?: boolean;
  /**
   * Enable using CGNAT virtual IPv4 addressing.
   */
  useZtVirtualIp?: boolean;
}

export type DeviceSettingsAttributes = DeviceSettingsSnapshot & {
  /** Account that owns the device settings singleton. */
  accountId: string;
  /**
   * The settings the account had before Alchemy first patched them.
   * Restored (via PUT, which resets unspecified fields) on destroy, so
   * deleting the resource puts the account back the way it was found.
   */
  initialSettings: DeviceSettingsSnapshot;
};

export type DeviceSettings = Resource<
  TypeId,
  DeviceSettingsProps,
  DeviceSettingsAttributes,
  never,
  Providers
>;

/**
 * Manages the **singleton** Cloudflare Zero Trust **device settings** for
 * an account (`/accounts/{accountId}/devices/settings`) — account-wide
 * WARP toggles like the Gateway TCP/UDP proxy, managed root certificate
 * installation, and CGNAT virtual IP.
 *
 * The singleton always exists, so reconcile patches only the declared
 * fields in place. The pre-management snapshot is captured on first touch
 * and restored on destroy (capture-and-restore), returning the account to
 * the state Alchemy found it in.
 * @resource
 * @product Devices
 * @category Cloudflare One (Zero Trust)
 * @section Managing device settings
 * @example Enable the Gateway proxy
 * ```typescript
 * yield* Cloudflare.Devices.DeviceSettings("Devices", {
 *   gatewayProxyEnabled: true,
 *   gatewayUdpProxyEnabled: true,
 * });
 * ```
 *
 * @example Allow one-hour WARP override codes
 * ```typescript
 * yield* Cloudflare.Devices.DeviceSettings("Devices", {
 *   disableForTime: 3600,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/
 */
export const DeviceSettings = Resource<DeviceSettings>(TypeId);

/**
 * Returns true if the given value is a DeviceSettings resource.
 */
export const isDeviceSettings = (value: unknown): value is DeviceSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DeviceSettingsProvider = () =>
  Provider.succeed(DeviceSettings, {
    nuke: { singleton: true },
    stables: ["accountId", "initialSettings"],

    // Account singleton: there is exactly one device-settings object per
    // account and no enumeration API. Mirror `read` — observe the single
    // singleton and return it as a one-element array. With no prior
    // output, the observed snapshot is itself the restore target.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* observeSettings(accountId);
      return [toAttributes(accountId, observed, observed)];
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = yield* observeSettings(acct);
      // The singleton always exists with account defaults — there is
      // nothing to "own", so a cold read adopts freely. The observed
      // snapshot at adoption time becomes the restore target.
      const initialSettings = output?.initialSettings ?? observed;
      return toAttributes(acct, observed, initialSettings);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the singleton always exists; read its live state.
      const observed = yield* observeSettings(accountId);

      // 2. Capture — the pre-management snapshot, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch.
      const initialSettings = output?.initialSettings ?? observed;

      // 3. Sync — patch only the declared fields that differ.
      const changes: Partial<DeviceSettingsSnapshot> = {};
      const assign = <K extends keyof DeviceSettingsSnapshot>(
        key: K,
        value: DeviceSettingsSnapshot[K],
      ) => {
        changes[key] = value;
      };
      let dirty = false;
      for (const key of SETTING_KEYS) {
        const desired = news[key];
        if (desired === undefined) continue;
        if (observed[key] !== desired) {
          assign(key, desired);
          dirty = true;
        }
      }
      if (!dirty) {
        return toAttributes(accountId, observed, initialSettings);
      }
      yield* zeroTrust.patchDeviceSetting({ accountId, ...changes });

      // 4. Return — re-read so attrs reflect post-sync truth.
      const final = yield* observeSettings(accountId);
      return toAttributes(accountId, final, initialSettings);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, initialSettings } = output;
      // Observe — skip the restore when the account already matches the
      // captured snapshot (idempotent re-delete after a crashed run).
      const observed = yield* observeSettings(accountId);
      if (sameSnapshot(observed, initialSettings)) return;
      // Restore via PUT: fields absent from the captured snapshot were
      // unset before we managed the singleton, and PUT resets them.
      yield* zeroTrust.putDeviceSetting({ accountId, ...initialSettings });
    }),
  });

const SETTING_KEYS = [
  "disableForTime",
  "externalEmergencySignalEnabled",
  "externalEmergencySignalFingerprint",
  "externalEmergencySignalInterval",
  "externalEmergencySignalUrl",
  "gatewayProxyEnabled",
  "gatewayUdpProxyEnabled",
  "rootCertificateInstallationEnabled",
  "useZtVirtualIp",
] as const satisfies readonly (keyof DeviceSettingsSnapshot)[];

/**
 * Read the live settings, normalized to a `null`-free snapshot.
 */
const observeSettings = (accountId: string) =>
  zeroTrust.getDeviceSetting({ accountId }).pipe(
    Effect.map((s): DeviceSettingsSnapshot => {
      const snapshot: DeviceSettingsSnapshot = {};
      if (s.disableForTime != null) snapshot.disableForTime = s.disableForTime;
      if (s.externalEmergencySignalEnabled != null) {
        snapshot.externalEmergencySignalEnabled =
          s.externalEmergencySignalEnabled;
      }
      if (s.externalEmergencySignalFingerprint != null) {
        snapshot.externalEmergencySignalFingerprint =
          s.externalEmergencySignalFingerprint;
      }
      if (s.externalEmergencySignalInterval != null) {
        snapshot.externalEmergencySignalInterval =
          s.externalEmergencySignalInterval;
      }
      if (s.externalEmergencySignalUrl != null) {
        snapshot.externalEmergencySignalUrl = s.externalEmergencySignalUrl;
      }
      if (s.gatewayProxyEnabled != null) {
        snapshot.gatewayProxyEnabled = s.gatewayProxyEnabled;
      }
      if (s.gatewayUdpProxyEnabled != null) {
        snapshot.gatewayUdpProxyEnabled = s.gatewayUdpProxyEnabled;
      }
      if (s.rootCertificateInstallationEnabled != null) {
        snapshot.rootCertificateInstallationEnabled =
          s.rootCertificateInstallationEnabled;
      }
      if (s.useZtVirtualIp != null) snapshot.useZtVirtualIp = s.useZtVirtualIp;
      return snapshot;
    }),
  );

const toAttributes = (
  accountId: string,
  observed: DeviceSettingsSnapshot,
  initialSettings: DeviceSettingsSnapshot,
): DeviceSettingsAttributes => ({
  ...observed,
  accountId,
  initialSettings,
});

const sameSnapshot = (
  a: DeviceSettingsSnapshot,
  b: DeviceSettingsSnapshot,
): boolean => SETTING_KEYS.every((key) => a[key] === b[key]);
