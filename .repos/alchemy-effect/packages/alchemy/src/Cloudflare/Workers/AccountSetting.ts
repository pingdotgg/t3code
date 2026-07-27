import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.AccountSetting" as const;
type TypeId = typeof TypeId;

export type AccountSettingProps = {
  /**
   * Default usage model applied to new Workers in this account (e.g.
   * `"standard"`). Mostly legacy since Workers Standard pricing — new
   * accounts only support `"standard"`.
   *
   * Mutable — updated in place. When omitted, the account's current value
   * is left untouched.
   * @default keep the account's current value
   */
  defaultUsageModel?: string;
  /**
   * Whether Green Compute is enabled for the account. When enabled,
   * scheduled (cron) Workers run only on hardware powered by renewable
   * energy.
   *
   * Mutable — updated in place. When omitted, the account's current value
   * is left untouched.
   * @default keep the account's current value
   */
  greenCompute?: boolean;
};

export type AccountSettingAttributes = {
  /** The Cloudflare account these settings belong to. */
  accountId: string;
  /** Resolved default usage model for the account. */
  defaultUsageModel: string | undefined;
  /** Resolved Green Compute flag for the account. */
  greenCompute: boolean | undefined;
  /**
   * The `defaultUsageModel` the account had before Alchemy first managed
   * this singleton. Restored on destroy.
   */
  initialDefaultUsageModel: string | undefined;
  /**
   * The `greenCompute` flag the account had before Alchemy first managed
   * this singleton. Restored on destroy.
   */
  initialGreenCompute: boolean | undefined;
};

export type AccountSetting = Resource<
  TypeId,
  AccountSettingProps,
  AccountSettingAttributes,
  never,
  Providers
>;

/**
 * The account-wide Workers settings singleton
 * (`/accounts/{account_id}/workers/account-settings`): the default usage
 * model for new Workers and the Green Compute flag for scheduled Workers.
 *
 * This is a singleton — it always exists on every account with Cloudflare
 * defaults, so this resource never creates or deletes anything physical.
 * Reconcile PUTs the settings when the observed values differ from the
 * desired ones; destroy restores the values the account had before Alchemy
 * first managed it (captured as `initialDefaultUsageModel` /
 * `initialGreenCompute`).
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Managing account settings
 * @example Enable Green Compute for scheduled Workers
 * ```typescript
 * yield* Cloudflare.Workers.AccountSetting("GreenCompute", {
 *   greenCompute: true,
 * });
 * ```
 *
 * @example Pin the default usage model
 * ```typescript
 * yield* Cloudflare.Workers.AccountSetting("UsageModel", {
 *   defaultUsageModel: "standard",
 *   greenCompute: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/workers/subresources/account_settings/
 */
export const AccountSetting = Resource<AccountSetting>(TypeId);

/**
 * Returns true if the given value is a AccountSetting resource.
 */
export const isAccountSetting = (value: unknown): value is AccountSetting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AccountSettingProvider = () =>
  Provider.succeed(AccountSetting, {
    nuke: { singleton: true },
    stables: ["accountId", "initialDefaultUsageModel", "initialGreenCompute"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The singleton's identity is the account it lives on.
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = yield* workers.getAccountSetting({ accountId: acct });
      // The settings singleton always exists with Cloudflare defaults —
      // there is nothing to "own", so a cold read adopts freely (never
      // `Unowned`). The observed values at adoption time become the
      // initial values restored on destroy.
      return toAttributes(
        acct,
        observed,
        output !== undefined
          ? output.initialDefaultUsageModel
          : (observed.defaultUsageModel ?? undefined),
        output !== undefined
          ? output.initialGreenCompute
          : (observed.greenCompute ?? undefined),
      );
    }),

    // Account-scoped singleton: there is no collection API — the settings
    // object always exists once per account. Read the single live object and
    // return it as a one-element array, exactly mirroring `read` (a cold
    // observation where the observed values are the initial values).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* workers.getAccountSetting({ accountId });
      return [
        toAttributes(
          accountId,
          observed,
          observed.defaultUsageModel ?? undefined,
          observed.greenCompute ?? undefined,
        ),
      ];
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the singleton always exists; read its live values.
      const observed = yield* workers.getAccountSetting({ accountId });

      // 2. Capture — the pre-management values, restored on destroy.
      //    `output` (including an adoption read) already carries them;
      //    otherwise this is our first touch and the observed values are
      //    the account's originals.
      const initialDefaultUsageModel =
        output !== undefined
          ? output.initialDefaultUsageModel
          : (observed.defaultUsageModel ?? undefined);
      const initialGreenCompute =
        output !== undefined
          ? output.initialGreenCompute
          : (observed.greenCompute ?? undefined);

      // 3. Sync — desired = news merged over observed (unspecified props
      //    keep the account's current value); PUT only when dirty.
      const desired = {
        defaultUsageModel:
          news.defaultUsageModel ?? observed.defaultUsageModel ?? undefined,
        greenCompute: news.greenCompute ?? observed.greenCompute ?? undefined,
      };
      const dirty =
        (news.defaultUsageModel !== undefined &&
          (observed.defaultUsageModel ?? undefined) !==
            news.defaultUsageModel) ||
        (news.greenCompute !== undefined &&
          (observed.greenCompute ?? undefined) !== news.greenCompute);
      if (!dirty) {
        return toAttributes(
          accountId,
          observed,
          initialDefaultUsageModel,
          initialGreenCompute,
        );
      }

      yield* workers.putAccountSetting({ accountId, ...desired });
      // 4. Return — the PUT is authoritative for what we just wrote. We do
      //    NOT re-read here: `getAccountSetting` is eventually consistent and
      //    can briefly echo the pre-write values right after a PUT (observed
      //    under concurrent load), which would surface a stale `greenCompute`
      //    in the reconcile output. The values we sent are the new state.
      return {
        accountId,
        defaultUsageModel: desired.defaultUsageModel,
        greenCompute: desired.greenCompute,
        initialDefaultUsageModel,
        initialGreenCompute,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, initialDefaultUsageModel, initialGreenCompute } =
        output;
      // There is no DELETE API — destroy restores the pre-management
      // values. Skip the call when the live values already match
      // (idempotent re-delete after a crashed run).
      const observed = yield* workers.getAccountSetting({ accountId });
      const dirty =
        (initialDefaultUsageModel !== undefined &&
          (observed.defaultUsageModel ?? undefined) !==
            initialDefaultUsageModel) ||
        (initialGreenCompute !== undefined &&
          (observed.greenCompute ?? undefined) !== initialGreenCompute);
      if (!dirty) return;
      yield* workers.putAccountSetting({
        accountId,
        defaultUsageModel:
          initialDefaultUsageModel ?? observed.defaultUsageModel ?? undefined,
        greenCompute: initialGreenCompute ?? observed.greenCompute ?? undefined,
      });
    }),
  });

const toAttributes = (
  accountId: string,
  observed: workers.GetAccountSettingResponse,
  initialDefaultUsageModel: string | undefined,
  initialGreenCompute: boolean | undefined,
): AccountSettingAttributes => ({
  accountId,
  defaultUsageModel: observed.defaultUsageModel ?? undefined,
  greenCompute: observed.greenCompute ?? undefined,
  initialDefaultUsageModel,
  initialGreenCompute,
});
