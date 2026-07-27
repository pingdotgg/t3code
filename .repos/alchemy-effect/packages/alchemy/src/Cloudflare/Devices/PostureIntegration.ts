import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Devices.PostureIntegration" as const;
type TypeId = typeof TypeId;

/**
 * The third-party provider behind the posture integration. Determines
 * which {@link DevicePostureIntegrationConfig} fields are required.
 */
export type DevicePostureIntegrationType =
  | "workspace_one"
  | "crowdstrike_s2s"
  | "uptycs"
  | "intune"
  | "kolide"
  | "tanium_s2s"
  | "sentinelone_s2s"
  | "custom_s2s";

/**
 * Connection settings for the third-party posture provider. Which fields
 * are required depends on the integration `type`:
 *
 * - `workspace_one` — `apiUrl`, `authUrl`, `clientId`, `clientSecret`
 * - `crowdstrike_s2s` — `apiUrl`, `clientId`, `clientSecret`, `customerId`
 * - `uptycs` — `apiUrl`, `clientKey`, `clientSecret`, `customerId`
 * - `intune` — `clientId`, `clientSecret`, `customerId`
 * - `kolide` — `clientId`, `clientSecret`
 * - `tanium_s2s` — `apiUrl`, `clientSecret`, optional `accessClientId` /
 *   `accessClientSecret`
 * - `sentinelone_s2s` — `apiUrl`, `clientSecret`
 * - `custom_s2s` — `apiUrl`, `clientSecret`, `accessClientId`,
 *   `accessClientSecret`
 *
 * Secrets are write-only: Cloudflare never returns them on reads, so they
 * are carried forward from the desired state.
 */
export interface DevicePostureIntegrationConfig {
  /** The third-party API URL the integration polls. */
  apiUrl?: string;
  /** The OAuth authorization URL (workspace_one). */
  authUrl?: string;
  /** The OAuth client ID used to authenticate with the provider. */
  clientId?: string;
  /** The client key (uptycs). */
  clientKey?: string;
  /** The customer/tenant identifier (crowdstrike, uptycs, intune). */
  customerId?: string;
  /** The OAuth client secret. Write-only — never returned on reads. */
  clientSecret?: Redacted.Redacted<string>;
  /** Access service-token client ID guarding the custom endpoint. */
  accessClientId?: string;
  /** Access service-token client secret. Write-only. */
  accessClientSecret?: Redacted.Redacted<string>;
}

export interface DevicePostureIntegrationProps {
  /**
   * Name of the posture integration. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The third-party provider type. Immutable — changing it triggers a
   * replacement.
   */
  type: DevicePostureIntegrationType;
  /**
   * The interval between each posture check against the third-party API.
   * Use `m` for minutes (e.g. `5m`) and `h` for hours (e.g. `12h`).
   */
  interval: string;
  /**
   * Connection settings for the provider (see
   * {@link DevicePostureIntegrationConfig} for the per-type field
   * requirements). Cloudflare validates the credentials against the live
   * third-party API on create/update.
   */
  config: DevicePostureIntegrationConfig;
}

export type DevicePostureIntegrationAttributes = {
  /** API UUID of the posture integration. */
  integrationId: string;
  /** Account that owns the integration. */
  accountId: string;
  /** Observed integration name. */
  name: string;
  /** The third-party provider type. */
  type: DevicePostureIntegrationType;
  /** Observed polling interval. */
  interval: string;
  /** Non-secret connection details as reported by Cloudflare. */
  config: {
    apiUrl: string | undefined;
    authUrl: string | undefined;
    clientId: string | undefined;
  };
};

export type DevicePostureIntegration = Resource<
  TypeId,
  DevicePostureIntegrationProps,
  DevicePostureIntegrationAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **device posture integration** — a service-to-
 * service connection to a third-party endpoint security provider
 * (CrowdStrike, Intune, Kolide, Workspace ONE, ...) whose signals power
 * `*_s2s` device posture rules.
 *
 * Cloudflare validates the configured credentials against the live
 * provider API at create/update time, so a reachable third-party tenant
 * is required.
 * @resource
 * @product Devices
 * @category Cloudflare One (Zero Trust)
 * @section Creating a posture integration
 * @example CrowdStrike Falcon
 * ```typescript
 * const falcon = yield* Cloudflare.Devices.DevicePostureIntegration("Falcon", {
 *   type: "crowdstrike_s2s",
 *   interval: "10m",
 *   config: {
 *     apiUrl: "https://api.crowdstrike.com",
 *     clientId: Alchemy.env("CROWDSTRIKE_CLIENT_ID"),
 *     clientSecret: Redacted.make(process.env.CROWDSTRIKE_SECRET!),
 *     customerId: "ccid-1234",
 *   },
 * });
 * ```
 *
 * @example Custom service-to-service provider behind Access
 * ```typescript
 * const custom = yield* Cloudflare.Devices.DevicePostureIntegration("Custom", {
 *   type: "custom_s2s",
 *   interval: "30m",
 *   config: {
 *     apiUrl: "https://posture.example.com/check",
 *     clientSecret: Redacted.make(process.env.POSTURE_SECRET!),
 *     accessClientId: serviceToken.clientId,
 *     accessClientSecret: serviceToken.clientSecret,
 *   },
 * });
 * ```
 *
 * @example Reference the integration from a posture rule
 * ```typescript
 * yield* Cloudflare.Devices.DevicePostureRule("FalconScore", {
 *   type: "crowdstrike_s2s",
 *   input: { connectionId: falcon.integrationId, os: "windows" },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/identity/devices/service-providers/
 */
export const DevicePostureIntegration =
  Resource<DevicePostureIntegration>(TypeId);

/**
 * Returns true if the given value is a DevicePostureIntegration resource.
 */
export const isDevicePostureIntegration = (
  value: unknown,
): value is DevicePostureIntegration =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DevicePostureIntegrationProvider = () =>
  Provider.succeed(DevicePostureIntegration, {
    stables: ["integrationId", "accountId", "type"],

    // Account collection — enumerate every posture integration in the
    // ambient account, exhaustively paginating the distilled list op.
    // Zero Trust is plan-gated; a `Forbidden` rejection means the account
    // lacks the entitlement, so treat it as "nothing to list".
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listDevicePostureIntegrations
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((i) => toAttributes(i, accountId)),
            ),
          ),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The provider type is immutable on Cloudflare's side — the config
      // shapes are disjoint, so model a type change as replacement.
      const oldType = output?.type ?? olds?.type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.integrationId) {
        const observed = yield* observeIntegration(acct, output.integrationId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold lookup by deterministic name. The list result carries no
      // ownership markers, so brand the match `Unowned` and let the
      // engine gate takeover behind the adopt policy.
      const name = yield* createIntegrationName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createIntegrationName(id, news.name);

      // 1. Observe — `output.integrationId` is a cached hint; fall back to
      //    a name scan so a crashed prior run converges.
      let observed = output?.integrationId
        ? yield* observeIntegration(accountId, output.integrationId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* zeroTrust.createDevicePostureIntegration({
          accountId,
          name,
          type: news.type,
          interval: news.interval,
          config: encodeConfig(news.config),
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — secrets are masked on reads so they cannot be diffed
      //    against observed state; PATCH when any observable field drifts
      //    OR when the desired config carries secrets that may have
      //    rotated. Cloudflare re-validates credentials on PATCH, so only
      //    send config when the non-secret surface differs.
      const sameObservable =
        (observed.name ?? "") === name &&
        (observed.interval ?? "") === news.interval &&
        sameObservedConfig(observed.config, news.config);
      if (sameObservable) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.patchDevicePostureIntegration({
        accountId,
        integrationId: observed.id!,
        name,
        type: news.type,
        interval: news.interval,
        config: encodeConfig(news.config),
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteDevicePostureIntegration({
          accountId: output.accountId,
          integrationId: output.integrationId,
        })
        .pipe(
          Effect.catchTag(
            "DevicePostureIntegrationNotFound",
            () => Effect.void,
          ),
        );
    }),
  });

/**
 * Structural shape shared by get/list/create/patch responses.
 */
type ObservedIntegration = {
  id?: string | null;
  config?: { apiUrl: string; authUrl: string; clientId: string } | null;
  interval?: string | null;
  name?: string | null;
  type?: (string & {}) | null;
};

/**
 * Read an integration by id, mapping "gone" to `undefined`.
 */
const observeIntegration = (accountId: string, integrationId: string) =>
  zeroTrust
    .getDevicePostureIntegration({ accountId, integrationId })
    .pipe(
      Effect.catchTag("DevicePostureIntegrationNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find an integration by exact name.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust
    .listDevicePostureIntegrations({ accountId })
    .pipe(
      Effect.map((list) =>
        list.result.find((i) => i.name === name && i.id != null),
      ),
    );

const createIntegrationName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

type EncodedConfig = Parameters<
  typeof zeroTrust.createDevicePostureIntegration
>[0]["config"];

/**
 * Project the alchemy config (flat, secrets `Redacted`) onto the wire
 * shape. The distilled request type is a union of per-provider structs;
 * the API discriminates by the sibling `type` field, so a single
 * present-fields projection is sufficient. The localized cast bridges the
 * flat shape to the union — it never touches error handling.
 */
const encodeConfig = (
  config: DevicePostureIntegrationConfig,
): EncodedConfig => {
  const out: Record<string, string> = {};
  if (config.apiUrl !== undefined) out.apiUrl = config.apiUrl;
  if (config.authUrl !== undefined) out.authUrl = config.authUrl;
  if (config.clientId !== undefined) out.clientId = config.clientId;
  if (config.clientKey !== undefined) out.clientKey = config.clientKey;
  if (config.customerId !== undefined) out.customerId = config.customerId;
  if (config.clientSecret !== undefined) {
    out.clientSecret = Redacted.value(config.clientSecret);
  }
  if (config.accessClientId !== undefined) {
    out.accessClientId = config.accessClientId;
  }
  if (config.accessClientSecret !== undefined) {
    out.accessClientSecret = Redacted.value(config.accessClientSecret);
  }
  return out as EncodedConfig;
};

/**
 * Compare only the fields Cloudflare echoes back (secrets are masked).
 */
const sameObservedConfig = (
  observed: ObservedIntegration["config"],
  desired: DevicePostureIntegrationConfig,
): boolean =>
  observed != null &&
  (desired.apiUrl === undefined || observed.apiUrl === desired.apiUrl) &&
  (desired.authUrl === undefined || observed.authUrl === desired.authUrl) &&
  (desired.clientId === undefined || observed.clientId === desired.clientId);

const toAttributes = (
  integration: ObservedIntegration,
  accountId: string,
): DevicePostureIntegrationAttributes => ({
  integrationId: integration.id ?? "",
  accountId,
  name: integration.name ?? "",
  type: (integration.type ?? "custom_s2s") as DevicePostureIntegrationType,
  interval: integration.interval ?? "",
  config: {
    apiUrl: integration.config?.apiUrl ?? undefined,
    authUrl: integration.config?.authUrl ?? undefined,
    clientId: integration.config?.clientId ?? undefined,
  },
});
