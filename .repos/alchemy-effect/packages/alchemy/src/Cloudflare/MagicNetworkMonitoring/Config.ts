import * as mnm from "@distilled.cloud/cloudflare/magic-network-monitoring";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MagicNetworkMonitoring.Config" as const;
type TypeId = typeof TypeId;

/**
 * A WARP device registered as a flow-data source on the MNM config.
 */
export interface WarpDevice {
  /**
   * Unique identifier of the WARP device.
   */
  id: string;
  /**
   * Display name of the WARP device.
   */
  name: string;
  /**
   * IPv4 address the WARP device sends flow data from.
   */
  routerIp: string;
}

export interface ConfigProps {
  /**
   * The account name label stored on the MNM configuration. Freeform —
   * mutable in place.
   */
  name: string;
  /**
   * Fallback sampling rate of flow messages being sent in packets per
   * second. This should match the packet sampling rate configured on the
   * router. Minimum of 1. Mutable in place.
   */
  defaultSampling: number;
  /**
   * IPv4 CIDR addresses (`/32`) of the routers that send flow data to
   * Cloudflare. Registering router flow sources requires the Magic Network
   * Monitoring router-flow entitlement — accounts without it reject any
   * non-empty value with the typed `InvalidMnmConfig` error (Cloudflare
   * code 1003).
   * @default []
   */
  routerIps?: string[];
  /**
   * WARP devices registered as flow-data sources.
   * @default []
   */
  warpDevices?: WarpDevice[];
}

export interface ConfigAttributes {
  /** The Cloudflare account the configuration belongs to. */
  accountId: string;
  /** The account name label stored on the configuration. */
  name: string;
  /** Sampling rate of flow messages in packets per second. */
  defaultSampling: number;
  /** Router IPs registered as flow-data sources. */
  routerIps: string[];
  /** WARP devices registered as flow-data sources. */
  warpDevices: WarpDevice[];
}

export type Config = Resource<
  TypeId,
  ConfigProps,
  ConfigAttributes,
  never,
  Providers
>;

/**
 * The Magic Network Monitoring (MNM) account configuration — the singleton
 * that registers your network's routers (and optionally WARP devices) as
 * flow-data sources and sets the fallback packet sampling rate.
 *
 * There is exactly one MNM configuration per Cloudflare account, and MNM
 * rules cannot be created until it exists. Creating a second configuration
 * fails (`MnmConfigAlreadyExists`), so reconcile tolerates the race by
 * falling through to an update. When the engine has no prior state but a
 * configuration already exists on the account, `read` reports it as
 * `Unowned` and takeover is gated behind `--adopt`.
 * @resource
 * @product Magic Network Monitoring
 * @category Network
 * @section Creating the configuration
 * @example Minimal configuration
 * ```typescript
 * const config = yield* Cloudflare.MagicNetworkMonitoring.Config("Mnm", {
 *   name: "my-network",
 *   defaultSampling: 1,
 * });
 * ```
 *
 * @example Configuration with router IPs
 * ```typescript
 * const config = yield* Cloudflare.MagicNetworkMonitoring.Config("Mnm", {
 *   name: "my-network",
 *   defaultSampling: 100,
 *   routerIps: ["203.0.113.1/32"],
 * });
 * ```
 *
 * @section Rules depend on the configuration
 * @example Create the config before any rules
 * ```typescript
 * const config = yield* Cloudflare.MagicNetworkMonitoring.Config("Mnm", {
 *   name: "my-network",
 *   defaultSampling: 1,
 * });
 * // Reference an output attribute so the rule deploys after the config.
 * yield* Cloudflare.MagicNetworkMonitoring.Rule("VolumetricAlert", {
 *   accountId: config.accountId,
 *   type: "threshold",
 *   prefixes: ["10.0.0.0/24"],
 *   bandwidthThreshold: 1_000_000,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-network-monitoring/
 */
export const Config = Resource<Config>(TypeId);

/**
 * Returns true if the given value is a Config resource.
 */
export const isConfig = (value: unknown): value is Config =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ConfigProvider = () =>
  Provider.succeed(Config, {
    stables: ["accountId"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The config is an account singleton — moving accounts replaces it.
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // A missing config answers HTTP 200 with `result: null` rather than
      // a 404 — `observe` maps that to `undefined`.
      const observed = observe(yield* mnm.getConfig({ accountId: acct }));
      if (observed === undefined) return undefined;
      // The config carries no ownership markers. With no prior state we
      // cannot prove we created it — report `Unowned` so the engine gates
      // takeover behind the adopt policy.
      const attributes = toAttributes(observed, acct);
      return output === undefined ? Unowned(attributes) : attributes;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const desired = {
        accountId,
        name: news.name,
        defaultSampling: news.defaultSampling,
        // Inputs have been resolved to concrete strings by Plan.
        routerIps: (news.routerIps ?? []) as string[],
        warpDevices: news.warpDevices ?? [],
      };

      // 1. Observe — a missing singleton answers `result: null` and maps
      //    to `undefined`.
      const observed = observe(yield* mnm.getConfig({ accountId }));

      // 2. Ensure — create when missing, converging a concurrent create
      //    (`MnmConfigAlreadyExists`, Cloudflare code 1005) into the
      //    update below.
      if (observed === undefined) {
        const created = observe(
          yield* mnm
            .createConfig(desired)
            .pipe(
              Effect.catchTag("MnmConfigAlreadyExists", () =>
                mnm.updateConfig(desired),
              ),
            ),
        );
        // `updateConfig` answers `result: null` if the config vanished
        // again mid-flight — fall back to one fresh create.
        if (created !== undefined) return toAttributes(created, accountId);
        const recreated = yield* mnm.createConfig(desired);
        return toAttributes(observe(recreated) ?? desired, accountId);
      }

      // 3. Sync — diff observed cloud state against desired; the update
      //    is a full-body PUT, so skip the call entirely on a no-op.
      const dirty =
        observed.name !== desired.name ||
        observed.defaultSampling !== desired.defaultSampling ||
        !sameStrings(observed.routerIps, desired.routerIps) ||
        !sameWarpDevices(observed.warpDevices, desired.warpDevices);
      if (!dirty) return toAttributes(observed, accountId);

      const updated = observe(yield* mnm.updateConfig(desired));
      if (updated !== undefined) return toAttributes(updated, accountId);
      // Deleted out-of-band between observe and update — recreate.
      const recreated = yield* mnm.createConfig(desired);
      return toAttributes(observe(recreated) ?? desired, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* mnm.deleteConfig({ accountId: output.accountId }).pipe(
        // Already gone (`MnmConfigNotFound`, Cloudflare code 1004).
        Effect.catchTag("MnmConfigNotFound", () => Effect.void),
      );
    }),

    // Account singleton — there is exactly one MNM config per account and
    // only a per-account `getConfig`. Mirror `read`: return the one-element
    // array when the config exists, `[]` when it is unset (HTTP 200 with
    // `result: null`, which `observe` maps to `undefined`).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = observe(yield* mnm.getConfig({ accountId }));
      return observed === undefined ? [] : [toAttributes(observed, accountId)];
    }),
  });

/**
 * A normalized, definitely-present MNM configuration.
 */
interface ObservedConfig {
  name: string;
  defaultSampling: number;
  routerIps: readonly string[];
  warpDevices: readonly WarpDevice[];
}

/**
 * Normalize a config response to a definitely-present shape, mapping
 * "missing" to `undefined`. Cloudflare answers HTTP 200 with
 * `result: null` when no config exists; the distilled core client decodes
 * that as an empty object, so a config without a `name` (a required field
 * on every real config) means there is no config.
 */
const observe = (
  config: mnm.GetConfigResponse | mnm.UpdateConfigResponse,
): ObservedConfig | undefined => {
  if (config === null) return undefined;
  const { name, defaultSampling } = config;
  if (name == null || defaultSampling == null) return undefined;
  return {
    name,
    defaultSampling,
    routerIps: config.routerIps ?? [],
    warpDevices: config.warpDevices ?? [],
  };
};

const sameStrings = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const sameWarpDevices = (
  observed: readonly WarpDevice[],
  desired: readonly WarpDevice[],
) =>
  observed.length === desired.length &&
  serializeWarpDevices(observed) === serializeWarpDevices(desired);

const serializeWarpDevices = (devices: readonly WarpDevice[]) =>
  devices
    .map((d) => `${d.id}|${d.name}|${d.routerIp}`)
    .sort()
    .join(",");

const toAttributes = (
  config: ObservedConfig,
  accountId: string,
): ConfigAttributes => ({
  accountId,
  name: config.name,
  defaultSampling: config.defaultSampling,
  routerIps: [...config.routerIps],
  warpDevices: config.warpDevices.map((d) => ({
    id: d.id,
    name: d.name,
    routerIp: d.routerIp,
  })),
});
