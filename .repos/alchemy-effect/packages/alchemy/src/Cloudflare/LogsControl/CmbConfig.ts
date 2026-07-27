import * as logs from "@distilled.cloud/cloudflare/logs";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Logs.CmbConfig" as const;
type TypeId = typeof TypeId;

export type CmbConfigProps = {
  /**
   * The Cloudflare account whose Customer Metadata Boundary (CMB) log
   * configuration is managed. The config is an account-level singleton, so
   * the account is the resource's identity — changing it triggers a
   * replacement.
   * @default the account from the active Cloudflare profile
   */
  accountId?: string;
  /**
   * Name of the region log data is restricted to (e.g. `"eu"`).
   *
   * Changing the CMB region affects where ALL logs for the account are
   * stored and processed — treat this as a destructive, account-wide
   * setting.
   */
  regions?: string;
  /**
   * Whether log data may be accessed from outside the configured region.
   * @default false
   */
  allowOutOfRegionAccess?: boolean;
};

export type CmbConfigAttributes = {
  /** The Cloudflare account the CMB config belongs to. */
  accountId: string;
  /** Name of the region log data is restricted to. */
  regions: string | undefined;
  /** Whether log data may be accessed from outside the configured region. */
  allowOutOfRegionAccess: boolean | undefined;
};

export type CmbConfig = Resource<
  TypeId,
  CmbConfigProps,
  CmbConfigAttributes,
  never,
  Providers
>;

/**
 * The account-level Customer Metadata Boundary (CMB) configuration for
 * Cloudflare Logs (`/accounts/{account_id}/logs/control/cmb/config`).
 *
 * The CMB config is a true account singleton with PUT/DELETE semantics: the
 * POST endpoint is a full upsert, and DELETE removes the configuration
 * entirely (an account with no CMB config reads back as empty). Identity is
 * the account itself.
 *
 * CMB is part of Cloudflare's Data Localization Suite and requires an
 * Enterprise plan — on unentitled accounts every operation fails with the
 * typed `LogsControlNotAuthorized` error.
 *
 * :::warning
 * Changing the CMB region changes where ALL logs for the account are stored
 * and processed, and deleting the config lifts the boundary. Handle with
 * care in production accounts.
 * :::
 * @resource
 * @product Logs
 * @category Observability & Analytics
 * @section Restricting logs to a region
 * @example Keep all account logs in the EU
 * ```typescript
 * const cmb = yield* Cloudflare.LogsControl.CmbConfig("EuLogs", {
 *   regions: "eu",
 * });
 * ```
 *
 * @example Allow out-of-region access
 * ```typescript
 * const cmb = yield* Cloudflare.LogsControl.CmbConfig("EuLogs", {
 *   regions: "eu",
 *   allowOutOfRegionAccess: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/data-localization/metadata-boundary/
 */
export const CmbConfig = Resource<CmbConfig>(TypeId);

/**
 * Returns true if the given value is a CmbConfig resource.
 */
export const isCmbConfig = (value: unknown): value is CmbConfig =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CmbConfigProvider = () =>
  Provider.succeed(CmbConfig, {
    stables: ["accountId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const newAccountId = news.accountId ?? accountId;
      // The account is the singleton's identity.
      if (output !== undefined && output.accountId !== newAccountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId: envAccountId } = yield* yield* CloudflareEnvironment;
      const accountId =
        output?.accountId ??
        (typeof olds?.accountId === "string" ? olds.accountId : envAccountId);
      const observed = yield* getCmbConfig(accountId);
      // Unconfigured account — the singleton does not currently exist.
      if (observed === undefined) return undefined;
      // The config is an account singleton — there is no foreign instance
      // to protect, so a cold read adopts freely.
      return toAttributes(accountId, observed);
    }),

    // Account singleton: there is no account-wide collection API, only the
    // single `/logs/control/cmb/config` GET. Mirror `read` exactly — return a
    // one-element array when the config is set, `[]` when the account is
    // unconfigured.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* getCmbConfig(accountId);
      return observed === undefined ? [] : [toAttributes(accountId, observed)];
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { accountId: envAccountId } = yield* yield* CloudflareEnvironment;
      // Inputs were resolved to concrete values by Plan.
      const accountId = (news.accountId as string | undefined) ?? envAccountId;

      // Observe — read the live config (undefined = unconfigured).
      const observed = yield* getCmbConfig(accountId);

      // Sync — POST is a full upsert; skip the call when the observed
      // config already matches the desired one.
      const desiredAllowOutOfRegionAccess = news.allowOutOfRegionAccess;
      const inSync =
        observed !== undefined &&
        (observed.regions ?? undefined) === news.regions &&
        (desiredAllowOutOfRegionAccess === undefined ||
          (observed.allowOutOfRegionAccess ?? false) ===
            desiredAllowOutOfRegionAccess);
      if (inSync) {
        return toAttributes(accountId, observed);
      }

      const created = yield* logs.createControlCmbConfig({
        accountId,
        regions: news.regions,
        allowOutOfRegionAccess: news.allowOutOfRegionAccess,
      });
      return toAttributes(accountId, created);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Observe — already unconfigured (or gone with the account) means
      // there is nothing to delete; re-delete after a crashed run is a
      // no-op.
      const observed = yield* getCmbConfig(output.accountId).pipe(
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return;
      yield* logs
        .deleteControlCmbConfig({ accountId: output.accountId })
        .pipe(
          Effect.catchTag(
            ["CmbConfigNotFound", "InvalidRoute"],
            () => Effect.void,
          ),
        );
    }),
  });

/**
 * Read the CMB config, normalizing "not configured" to `undefined`. An
 * unconfigured account answers with `result: null` (decoded as an empty
 * struct) or a 404 (`CmbConfigNotFound`).
 */
const getCmbConfig = (accountId: string) =>
  logs.getControlCmbConfig({ accountId }).pipe(
    Effect.map((config) =>
      config.regions === undefined || config.regions === null
        ? undefined
        : config,
    ),
    // Accounts without the Compliance/CMB entitlement get
    // `LogsControlNotAuthorized` — treat as unconfigured (nothing to manage).
    Effect.catchTag(["CmbConfigNotFound", "LogsControlNotAuthorized"], () =>
      Effect.succeed(undefined),
    ),
  );

const toAttributes = (
  accountId: string,
  config:
    | logs.GetControlCmbConfigResponse
    | logs.CreateControlCmbConfigResponse,
): CmbConfigAttributes => ({
  accountId,
  regions: config.regions ?? undefined,
  allowOutOfRegionAccess: config.allowOutOfRegionAccess ?? undefined,
});
